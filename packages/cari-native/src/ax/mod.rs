// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

//! AX — AST extraction stage. Phase R1-c.
//!
//! Extracts symbols, imports, calls, TODOs, rationale, and file entries
//! from TypeScript/JavaScript source files using oxc_parser + rayon.

use anyhow::Result;
use ignore::WalkBuilder;
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Expression,
    BindingPattern, ClassElement, Declaration, ExportDefaultDeclarationKind,
    ImportDeclarationSpecifier, MethodDefinitionKind, PropertyKey, Statement,
    TSAccessibility, TSModuleDeclarationName, TSSignature,
};
use oxc_parser::Parser;
use oxc_span::SourceType;
use rayon::prelude::*;
use std::path::{Path, PathBuf};

use crate::types::{AxResult, BuildOpts, FileEntry, Import, Rationale, Symbol, SymbolCall, Todo};

mod calls;
use oxc_ast_visit::Visit;

fn is_source_file(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    matches!(
        ext.as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs"
    )
}

/// Largest source file AX reads, in bytes (TypeScript `maxFileSize`).
const AX_MAX_FILE_SIZE: usize = 262_144;

/// Whether AX extracts symbols from a file. The TypeScript stage's discovery covers
/// `.ts/.tsx/.js/.jsx`, ignores `node_modules` and `dist`, `*.d.ts`, `*.test.ts`,
/// `*.spec.ts`, and does not follow dot-directories (tinyglobby defaults).
fn ax_extracts_symbols(rel_path: &str) -> bool {
    let parts: Vec<&str> = rel_path.split('/').collect();
    if parts.iter().any(|p| *p == "node_modules" || *p == "dist" || p.starts_with('.')) {
        return false;
    }
    let name = parts.last().copied().unwrap_or("");
    if name.ends_with(".d.ts") || name.ends_with(".test.ts") || name.ends_with(".spec.ts") {
        return false;
    }
    let ext = name.rsplit('.').next().unwrap_or("");
    matches!(ext, "ts" | "tsx" | "js" | "jsx")
}

fn build_line_index(text: &str) -> Vec<usize> {
    let mut idx = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            idx.push(i + 1);
        }
    }
    idx
}

pub(crate) fn byte_to_line(line_idx: &[usize], byte_pos: usize) -> i64 {
    match line_idx.binary_search(&byte_pos) {
        Ok(i) => (i + 1) as i64,
        Err(i) => i as i64,
    }
}

fn hash_text(text: &str) -> String {
    let hash = blake3::hash(text.as_bytes());
    hash.as_bytes()[..8]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// TypeScript treats a specifier starting with `.` or `/` as relative.
fn is_relative_specifier(specifier: &str) -> bool {
    specifier.starts_with('.') || specifier.starts_with('/')
}

/// Port of `resolveImportPath` (TypeScript AX stage): a relative specifier resolves to
/// `<base>.ts|.tsx|.js|.jsx` or `<base>/index.(ts|tsx|js|jsx)` on disk, with a trailing
/// JavaScript-style extension removed first. Anything else resolves to nothing.
fn resolve_import(root: &Path, source_file: &str, specifier: &str) -> Option<String> {
    if !is_relative_specifier(specifier) {
        return None;
    }
    let mut stripped = specifier;
    for ext in [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"] {
        if let Some(rest) = stripped.strip_suffix(ext) {
            stripped = rest;
            break;
        }
    }
    let dir = Path::new(source_file).parent().unwrap_or(Path::new(""));
    let mut parts: Vec<String> = dir
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    for component in Path::new(stripped).components() {
        match component {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            _ => {}
        }
    }
    let base = parts.join("/");
    let extensions = [".ts", ".tsx", ".js", ".jsx"];
    for ext in extensions {
        if root.join(format!("{base}{ext}")).exists() {
            return Some(format!("{base}{ext}"));
        }
    }
    for ext in extensions {
        if root.join(&base).join(format!("index{ext}")).exists() {
            return Some(if base.is_empty() {
                format!("index{ext}")
            } else {
                format!("{base}/index{ext}")
            });
        }
    }
    None
}

fn resolve_specifier(source_file: &str, specifier: &str) -> (String, bool) {
    if specifier.starts_with('.') {
        let dir = Path::new(source_file)
            .parent()
            .unwrap_or(Path::new(""));
        let joined = dir.join(specifier);
        let mut parts: Vec<String> = Vec::new();
        for component in joined.components() {
            match component {
                std::path::Component::ParentDir => {
                    parts.pop();
                }
                std::path::Component::CurDir => {}
                std::path::Component::Normal(s) => {
                    parts.push(s.to_string_lossy().to_string())
                }
                _ => {}
            }
        }
        (parts.join("/"), true)
    } else {
        (specifier.to_string(), false)
    }
}

fn property_key_name<'a>(key: &'a PropertyKey<'_>) -> Option<&'a str> {
    match key {
        PropertyKey::StaticIdentifier(id) => Some(id.name.as_str()),
        PropertyKey::PrivateIdentifier(id) => Some(id.name.as_str()),
        _ => None,
    }
}

fn extract_todos_rationale(content: &str, file_path: &str) -> (Vec<Todo>, Vec<Rationale>) {
    let mut todos = Vec::new();
    let mut rationale = Vec::new();
    for (line_idx, line) in content.lines().enumerate() {
        let line_no = (line_idx + 1) as i64;
        let trimmed = line.trim();
        let comment_body = if let Some(s) = trimmed.strip_prefix("//") {
            s.trim()
        } else {
            continue;
        };
        for kind in &["TODO", "FIXME", "HACK", "XXX"] {
            if comment_body.starts_with(kind) {
                let rest = comment_body[kind.len()..].trim_start_matches(':').trim();
                todos.push(Todo {
                    file_path: file_path.to_string(),
                    line: line_no,
                    kind: kind.to_string(),
                    text: rest.to_string(),
                });
                break;
            }
        }
        for kind in &["WHY", "NOTE", "IMPORTANT", "DESIGN"] {
            if comment_body.starts_with(kind) {
                let rest = comment_body[kind.len()..].trim_start_matches(':').trim();
                rationale.push(Rationale {
                    file_path: file_path.to_string(),
                    line: line_no,
                    kind: kind.to_string(),
                    text: rest.to_string(),
                    symbol: None,
                });
                break;
            }
        }
    }
    (todos, rationale)
}

fn params_string(params: &oxc_ast::ast::FormalParameters<'_>) -> String {
    params
        .items
        .iter()
        .filter_map(|p| match &p.pattern {
            BindingPattern::BindingIdentifier(id) => Some(id.name.as_str().to_string()),
            BindingPattern::AssignmentPattern(a) => match &a.left {
                BindingPattern::BindingIdentifier(id) => {
                    Some(id.name.as_str().to_string())
                }
                _ => Some("_".to_string()),
            },
            _ => Some("_".to_string()),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

struct FileExtractor<'s> {
    content: &'s str,
    rel_path: String,
    root: PathBuf,
    line_idx: Vec<usize>,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub calls: Vec<SymbolCall>,
}

impl<'s> FileExtractor<'s> {
    fn new(content: &'s str, rel_path: &str, root: &Path) -> Self {
        Self {
            content,
            rel_path: rel_path.to_string(),
            root: root.to_path_buf(),
            line_idx: build_line_index(content),
            symbols: Vec::new(),
            imports: Vec::new(),
            calls: Vec::new(),
        }
    }

    fn line(&self, byte: u32) -> i64 {
        byte_to_line(&self.line_idx, byte as usize)
    }

    fn span_text(&self, start: u32, end: u32) -> &str {
        let s = start as usize;
        let e = (end as usize).min(self.content.len());
        if s <= e {
            &self.content[s..e]
        } else {
            ""
        }
    }

    fn visit_decl(&mut self, decl: &Declaration<'_>, exported: bool, parent: Option<&str>) {
        match decl {
            Declaration::FunctionDeclaration(func) => {
                if let Some(id) = &func.id {
                    let name = id.name.as_str();
                    self.add_function_sym(
                        name,
                        "function",
                        exported,
                        parent,
                        func.r#async,
                        &func.params,
                        func.span.start,
                        func.span.end,
                    );
                }
            }
            Declaration::ClassDeclaration(class) => {
                let name = class
                    .id
                    .as_ref()
                    .map(|id| id.name.as_str())
                    .unwrap_or("(anonymous)");
                self.add_class_sym(name, exported, parent, class.span.start, class.span.end);
                self.visit_class_body(&class.body, name);
            }
            Declaration::TSInterfaceDeclaration(iface) => {
                let name = iface.id.name.as_str();
                self.push_symbol(Symbol {
                    name: name.to_string(),
                    kind: "interface".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(iface.span.start)),
                    end_line: Some(self.line(iface.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: Some(hash_text(self.span_text(iface.span.start, iface.span.end))),
                    body_lines: Some(self.line(iface.span.end) - self.line(iface.span.start) + 1),
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: name.starts_with('_'),
                    decorators: None,
                });
                self.visit_interface_body(&iface.body, name);
            }
            Declaration::TSModuleDeclaration(module) => {
                // A namespace is not a symbol in the TypeScript index, but its declarations
                // are: they are extracted without a container, as top-level ones are.
                if let Some(oxc_ast::ast::TSModuleDeclarationBody::TSModuleBlock(block)) = &module.body {
                    for stmt in block.body.iter() {
                        self.visit_statement(stmt, None, false);
                    }
                }
            }
            Declaration::TSTypeAliasDeclaration(alias) => {
                let name = alias.id.name.as_str();
                self.push_symbol(Symbol {
                    name: name.to_string(),
                    kind: "type".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(alias.span.start)),
                    end_line: Some(self.line(alias.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: None,
                    body_lines: None,
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: name.starts_with('_'),
                    decorators: None,
                });
            }
            Declaration::TSEnumDeclaration(en) => {
                let name = en.id.name.as_str();
                self.push_symbol(Symbol {
                    name: name.to_string(),
                    kind: "enum".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(en.span.start)),
                    end_line: Some(self.line(en.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: Some(hash_text(self.span_text(en.span.start, en.span.end))),
                    body_lines: Some(self.line(en.span.end) - self.line(en.span.start) + 1),
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: false,
                    decorators: None,
                });
            }
            Declaration::VariableDeclaration(var_decl) => {
                self.visit_variable_decl(var_decl, exported, parent);
            }
            _ => {}
        }
    }

    fn visit_statement(&mut self, stmt: &Statement<'_>, parent: Option<&str>, exported: bool) {
        match stmt {
            Statement::FunctionDeclaration(func) => {
                if let Some(id) = &func.id {
                    let name = id.name.as_str();
                    self.add_function_sym(
                        name,
                        "function",
                        exported,
                        parent,
                        func.r#async,
                        &func.params,
                        func.span.start,
                        func.span.end,
                    );
                }
            }
            Statement::ClassDeclaration(class) => {
                let name = class
                    .id
                    .as_ref()
                    .map(|id| id.name.as_str())
                    .unwrap_or("(anonymous)");
                self.add_class_sym(name, exported, parent, class.span.start, class.span.end);
                self.visit_class_body(&class.body, name);
            }
            Statement::ImportDeclaration(decl) => {
                self.visit_import(decl);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(decl) = &export.declaration {
                    self.visit_decl(decl, true, parent);
                }
                // Re-exports (`export … from`) are not recorded as imports, as in TypeScript.
            }
            Statement::ExportDefaultDeclaration(export) => {
                match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
                        let name = func
                            .id
                            .as_ref()
                            .map(|id| id.name.as_str())
                            .unwrap_or("default");
                        self.add_function_sym(
                            name,
                            "function",
                            true,
                            parent,
                            func.r#async,
                            &func.params,
                            func.span.start,
                            func.span.end,
                        );
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                        let name = class
                            .id
                            .as_ref()
                            .map(|id| id.name.as_str())
                            .unwrap_or("default");
                        self.add_class_sym(
                            name,
                            true,
                            parent,
                            class.span.start,
                            class.span.end,
                        );
                        self.visit_class_body(&class.body, name);
                    }
                    _ => {}
                }
            }
            Statement::VariableDeclaration(var_decl) => {
                self.visit_variable_decl(var_decl, exported, parent);
            }
            Statement::BlockStatement(block) => {
                for s in block.body.iter() {
                    self.visit_statement(s, parent, false);
                }
            }
            Statement::TSInterfaceDeclaration(iface) => {
                let name = iface.id.name.as_str();
                self.push_symbol(Symbol {
                    name: name.to_string(),
                    kind: "interface".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(iface.span.start)),
                    end_line: Some(self.line(iface.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: Some(hash_text(self.span_text(iface.span.start, iface.span.end))),
                    body_lines: Some(self.line(iface.span.end) - self.line(iface.span.start) + 1),
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: name.starts_with('_'),
                    decorators: None,
                });
                self.visit_interface_body(&iface.body, name);
            }
            Statement::TSModuleDeclaration(module) => {
                // Namespaces are not symbols in the TypeScript index; their declarations are.
                if let Some(oxc_ast::ast::TSModuleDeclarationBody::TSModuleBlock(block)) = &module.body {
                    for inner in block.body.iter() {
                        self.visit_statement(inner, None, false);
                    }
                }
            }
            Statement::TSTypeAliasDeclaration(alias) => {
                let name = alias.id.name.as_str();
                self.push_symbol(Symbol {
                    name: name.to_string(),
                    kind: "type".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(alias.span.start)),
                    end_line: Some(self.line(alias.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: None,
                    body_lines: None,
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: name.starts_with('_'),
                    decorators: None,
                });
            }
            Statement::TSEnumDeclaration(en) => {
                let name = en.id.name.as_str();
                self.push_symbol(Symbol {
                    name: name.to_string(),
                    kind: "enum".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(en.span.start)),
                    end_line: Some(self.line(en.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: Some(hash_text(self.span_text(en.span.start, en.span.end))),
                    body_lines: Some(self.line(en.span.end) - self.line(en.span.start) + 1),
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: false,
                    decorators: None,
                });
            }
            _ => {}
        }
    }

    fn push_symbol(&mut self, sym: Symbol) {
        self.symbols.push(sym);
    }

    fn add_class_sym(
        &mut self,
        name: &str,
        exported: bool,
        parent: Option<&str>,
        start: u32,
        end: u32,
    ) {
        self.symbols.push(Symbol {
            name: name.to_string(),
            kind: "class".to_string(),
            container: parent.map(String::from),
            signature: None,
            file_path: self.rel_path.clone(),
            line: Some(self.line(start)),
            end_line: Some(self.line(end)),
            export: exported,
            doc_summary: None,
            body_hash: Some(hash_text(self.span_text(start, end))),
            body_lines: Some(self.line(end) - self.line(start) + 1),
            structure_hash: None,
            implements: None,
            deprecated: false,
            deprecated_note: None,
            is_internal: name.starts_with('_'),
            decorators: None,
        });
    }

    fn visit_class_body(&mut self, body: &oxc_ast::ast::ClassBody<'_>, class_name: &str) {
        for elem in body.body.iter() {
            if let ClassElement::MethodDefinition(method) = elem {
                // The TypeScript index has one kind for every method form.
                let kind = "method";
                if let Some(method_name) = property_key_name(&method.key) {
                    let func = &method.value;
                    let param_str = params_string(&func.params);
                    let start = method.span.start;
                    let end = method.span.end;
                    let is_public = !matches!(
                        method.accessibility,
                        Some(TSAccessibility::Private) | Some(TSAccessibility::Protected)
                    );
                    self.symbols.push(Symbol {
                        name: method_name.to_string(),
                        kind: kind.to_string(),
                        container: Some(class_name.to_string()),
                        signature: Some(format!("{}({})", method_name, param_str)),
                        file_path: self.rel_path.clone(),
                        line: Some(self.line(start)),
                        end_line: Some(self.line(end)),
                        export: is_public,
                        doc_summary: None,
                        body_hash: Some(hash_text(self.span_text(start, end))),
                        body_lines: Some(self.line(end) - self.line(start) + 1),
                        structure_hash: None,
                        implements: None,
                        deprecated: false,
                        deprecated_note: None,
                        is_internal: method_name.starts_with('_'),
                        decorators: None,
                    });
                }
            } else if let ClassElement::PropertyDefinition(prop) = elem {
                if !prop.computed {
                    if let Some(prop_name) = property_key_name(&prop.key) {
                        let is_public = !matches!(
                            prop.accessibility,
                            Some(TSAccessibility::Private) | Some(TSAccessibility::Protected)
                        );
                        {
                            let start = prop.span.start;
                            let end = prop.span.end;
                            self.symbols.push(Symbol {
                                name: prop_name.to_string(),
                                kind: "property".to_string(),
                                container: Some(class_name.to_string()),
                                signature: None,
                                file_path: self.rel_path.clone(),
                                line: Some(self.line(start)),
                                end_line: Some(self.line(end)),
                                export: true,
                                doc_summary: None,
                                body_hash: None,
                                body_lines: None,
                                structure_hash: None,
                                implements: None,
                                deprecated: false,
                                deprecated_note: None,
                                is_internal: prop_name.starts_with('_'),
                                decorators: None,
                            });
                        }
                    }
                }
            }
        }
    }

    fn visit_interface_body(
        &mut self,
        body: &oxc_ast::ast::TSInterfaceBody<'_>,
        iface_name: &str,
    ) {
        for sig in body.body.iter() {
            match sig {
                TSSignature::TSPropertySignature(prop) => {
                    if !prop.computed {
                        // String-literal keys keep their quotes, as the TypeScript index does.
                        let key_name: Option<String> = property_key_name(&prop.key)
                            .map(String::from)
                            .or_else(|| match &prop.key {
                                PropertyKey::StringLiteral(lit) => {
                                    Some(self.span_text(lit.span.start, lit.span.end).to_string())
                                }
                                _ => None,
                            });
                        if let Some(name) = key_name {
                            self.symbols.push(Symbol {
                                name: name.to_string(),
                                kind: "property".to_string(),
                                container: Some(iface_name.to_string()),
                                signature: None,
                                file_path: self.rel_path.clone(),
                                line: Some(self.line(prop.span.start)),
                                end_line: Some(self.line(prop.span.end)),
                                export: false,
                                doc_summary: None,
                                body_hash: None,
                                body_lines: None,
                                structure_hash: None,
                                implements: None,
                                deprecated: false,
                                deprecated_note: None,
                                is_internal: name.starts_with('_'),
                                decorators: None,
                            });
                        }
                    }
                }
                TSSignature::TSMethodSignature(method_sig) => {
                    if !method_sig.computed {
                        if let Some(name) = property_key_name(&method_sig.key) {
                            let param_str = params_string(&method_sig.params);
                            self.symbols.push(Symbol {
                                name: name.to_string(),
                                kind: "method".to_string(),
                                container: Some(iface_name.to_string()),
                                signature: Some(format!("{}({})", name, param_str)),
                                file_path: self.rel_path.clone(),
                                line: Some(self.line(method_sig.span.start)),
                                end_line: Some(self.line(method_sig.span.end)),
                                export: false,
                                doc_summary: None,
                                body_hash: None,
                                body_lines: None,
                                structure_hash: None,
                                implements: None,
                                deprecated: false,
                                deprecated_note: None,
                                is_internal: name.starts_with('_'),
                                decorators: None,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_function_sym(
        &mut self,
        name: &str,
        kind: &str,
        exported: bool,
        parent: Option<&str>,
        is_async: bool,
        params: &oxc_ast::ast::FormalParameters<'_>,
        start: u32,
        end: u32,
    ) {
        let param_str = params_string(params);
        let body_text = self.span_text(start, end);
        self.symbols.push(Symbol {
            name: name.to_string(),
            kind: kind.to_string(),
            container: parent.map(String::from),
            signature: Some(if is_async {
                format!("async {}({})", name, param_str)
            } else {
                format!("{}({})", name, param_str)
            }),
            file_path: self.rel_path.clone(),
            line: Some(self.line(start)),
            end_line: Some(self.line(end)),
            export: exported,
            doc_summary: None,
            body_hash: Some(hash_text(body_text)),
            body_lines: Some(self.line(end) - self.line(start) + 1),
            structure_hash: None,
            implements: None,
            deprecated: false,
            deprecated_note: None,
            is_internal: name.starts_with('_'),
            decorators: None,
        });
    }

    fn visit_variable_decl(
        &mut self,
        var_decl: &oxc_ast::ast::VariableDeclaration<'_>,
        exported: bool,
        parent: Option<&str>,
    ) {
        for decl in var_decl.declarations.iter() {
            // TypeScript keeps a variable only when it holds a function, directly or as the
            // function argument of a call (React.memo(() => …)). Other variables are skipped.
            let Some(init) = &decl.init else { continue };
            let promoted = match init {
                Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => true,
                Expression::CallExpression(call) => call.arguments.iter().any(|arg| {
                    matches!(
                        arg,
                        oxc_ast::ast::Argument::ArrowFunctionExpression(_)
                            | oxc_ast::ast::Argument::FunctionExpression(_)
                    )
                }),
                _ => false,
            };
            if !promoted {
                continue;
            }
            if let BindingPattern::BindingIdentifier(id) = &decl.id {
                let name = id.name.as_str();
                self.symbols.push(Symbol {
                    name: name.to_string(),
                    kind: "function".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(decl.span.start)),
                    end_line: Some(self.line(decl.span.end)),
                    export: true,
                    doc_summary: None,
                    body_hash: None,
                    body_lines: None,
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: name.starts_with('_'),
                    decorators: None,
                });
            }
        }
    }

    fn visit_import(&mut self, decl: &oxc_ast::ast::ImportDeclaration<'_>) {
        let specifier = decl.source.value.as_str();
        // TypeScript records the imported name (not an alias), `default`, or `*`.
        let imported_names: Vec<String> = decl
            .specifiers
            .as_ref()
            .map(|specs| {
                specs
                    .iter()
                    .map(|s| match s {
                        ImportDeclarationSpecifier::ImportSpecifier(spec) => {
                            spec.imported.name().as_str().to_string()
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                            "default".to_string()
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                            "*".to_string()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.imports.push(Import {
            source_file: self.rel_path.clone(),
            target_file: resolve_import(&self.root, &self.rel_path, specifier),
            module_specifier: specifier.to_string(),
            line: Some(self.line(decl.span.start)),
            is_relative: is_relative_specifier(specifier),
            imported_names: if imported_names.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&imported_names).unwrap_or_default())
            },
        });
    }

}

struct ProcessedFile {
    symbols: Vec<Symbol>,
    imports: Vec<Import>,
    calls: Vec<SymbolCall>,
    todos: Vec<Todo>,
    rationale: Vec<Rationale>,
    file_entry: FileEntry,
}


/// Reserved words kept verbatim by the structure hash (TypeScript `RESERVED` in ax-helpers).
const RESERVED_WORDS: &[&str] = &[
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
    "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
    "null", "of", "return", "static", "super", "switch", "this", "throw", "true", "try", "type",
    "typeof", "undefined", "var", "void", "while", "with", "yield",
];

/// Truncate a documentation summary to 600 characters, as the TypeScript extractor does.
fn cap_summary(text: String) -> String {
    if text.chars().count() > 600 {
        let head: String = text.chars().take(597).collect();
        format!("{head}…")
    } else {
        text
    }
}

/// Documentation summary of the declaration starting at `start` (0-based line index).
/// Port of `extractDocComment` in ast-extractor: a JSDoc block directly above, then a run
/// of `//` lines, and never past real code.
fn doc_summary_at(lines: &[&str], start: usize) -> Option<String> {
    use regex::Regex;
    let single = Regex::new(r"^/\*+\s*(.+?)\s*\*/$").unwrap();
    let open = Regex::new(r"^/\*+\s*(.+)").unwrap();
    let star = Regex::new(r"^\*\s*(.*)").unwrap();

    let lower = start.saturating_sub(20);
    let mut i = start;
    while i > lower {
        i -= 1;
        let line = lines[i].trim();
        if line.starts_with("/**") || (line.starts_with("/*") && !line.starts_with("/**/")) {
            let mut parts: Vec<String> = Vec::new();
            for doc in lines.iter().take(start).skip(i).map(|l| l.trim()) {
                if doc.starts_with("* @") || doc.starts_with('@') {
                    break;
                }
                if matches!(doc, "/**" | "*/" | "/*" | "*") {
                    continue;
                }
                if let Some(c) = single.captures(doc) {
                    parts.push(c[1].to_string());
                    continue;
                }
                if let Some(c) = open.captures(doc) {
                    parts.push(c[1].to_string());
                    continue;
                }
                if let Some(c) = star.captures(doc) {
                    if !c[1].is_empty() {
                        parts.push(c[1].to_string());
                    }
                }
            }
            if !parts.is_empty() {
                let full = parts.join(" ");
                let full = full.split_whitespace().collect::<Vec<_>>().join(" ");
                return Some(cap_summary(full));
            }
            break;
        }
        if !line.is_empty() && !line.starts_with("//") && !line.starts_with('*') && !line.starts_with("*/") {
            break;
        }
    }

    let mut comments: Vec<String> = Vec::new();
    let lower = start.saturating_sub(10);
    let mut j = start;
    while j > lower {
        j -= 1;
        let line = lines[j].trim();
        if let Some(rest) = line.strip_prefix("//") {
            comments.insert(0, rest.strip_prefix(' ').unwrap_or(rest).to_string());
        } else {
            break;
        }
    }
    if comments.is_empty() {
        return None;
    }
    let full = comments.join(" ");
    let full = full.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(cap_summary(full))
}

/// Body hash, body length, and structure hash for a declaration spanning at least four
/// lines (TypeScript `computeBodyHash`). Hashes are SHA-256, truncated to 16 hex digits.
fn body_fingerprints(lines: &[&str], start: usize, end: usize) -> Option<(String, i64, String)> {
    use regex::Regex;
    use sha2::{Digest, Sha256};
    let count = end + 1 - start;
    if count < 4 {
        return None;
    }
    let body = lines
        .iter()
        .take(end)
        .skip(start - 1)
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    if body.is_empty() {
        return None;
    }
    let hex16 = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()))[..16].to_string();
    let body_hash = hex16(&body);

    let numeric = Regex::new(r"\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b").unwrap();
    let identifier = Regex::new(r"\b[a-zA-Z_$][a-zA-Z0-9_$]*\b").unwrap();
    let normalised = replace_string_literals(&body);
    let normalised = numeric.replace_all(&normalised, "0").to_string();
    let structural = identifier
        .replace_all(&normalised, |caps: &regex::Captures| {
            let word = &caps[0];
            if RESERVED_WORDS.contains(&word) { word.to_string() } else { "_".to_string() }
        })
        .to_string();
    Some((body_hash, count as i64, hex16(&structural)))
}

/// Replace each string literal (`'…'`, `"…"`, or `` `…` ``) with `"S"`, as the TypeScript
/// normalisation does. A literal is a quote, then characters that are neither that quote nor a
/// backslash (or an escaped character), then the same quote, all on one line.
fn replace_string_literals(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' || c == '"' || c == '`' {
            let mut j = i + 1;
            let mut closed = None;
            while j < chars.len() {
                let d = chars[j];
                if d == '\n' {
                    break;
                }
                if d == c {
                    closed = Some(j);
                    break;
                }
                if d == '\\' {
                    if j + 1 < chars.len() && chars[j + 1] != '\n' {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            if let Some(end) = closed {
                out.push_str("\"S\"");
                i = end + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Summaries, body and structure fingerprints for every symbol with a line span, as the
/// TypeScript AX stage records them.
fn apply_source_fingerprints(symbols: &mut [Symbol], content: &str) {
    let lines: Vec<&str> = content.lines().collect();
    // Top-level declarations by name: members look up their container's JSDoc.
    let containers: std::collections::HashMap<String, (String, bool, Option<String>)> = symbols
        .iter()
        .filter(|s| s.container.is_none())
        .filter_map(|s| {
            let line = s.line? as usize;
            if line == 0 || line > lines.len() {
                return None;
            }
            let (deprecated, note) = deprecation_at(&lines, line - 1);
            Some((s.name.clone(), (s.kind.clone(), deprecated, note)))
        })
        .collect();
    for sym in symbols.iter_mut() {
        let Some(line) = sym.line else { continue };
        let start = line as usize;
        if start == 0 || start > lines.len() {
            continue;
        }
        let container = sym.container.as_ref().and_then(|c| containers.get(c));
        // Properties never carry a summary. Interface methods have no body to document.
        let interface_member = container.map(|c| c.0 == "interface").unwrap_or(false);
        sym.doc_summary = if sym.kind == "property" || (sym.kind == "method" && interface_member) {
            None
        } else {
            doc_summary_at(&lines, start - 1)
        };
        let end = sym.end_line.map(|e| e as usize).unwrap_or(start);
        // Each fingerprint is set or cleared, so a value from an earlier pass cannot survive.
        let fingerprints = body_fingerprints(&lines, start, end);
        sym.body_hash = fingerprints.as_ref().map(|f| f.0.clone());
        sym.body_lines = fingerprints.as_ref().map(|f| f.1);
        sym.structure_hash = fingerprints.as_ref().map(|f| f.2.clone());
        // A member's documentation lookup lands on its container, so it inherits the
        // container's @deprecated tag.
        let (deprecated, note) = match container {
            Some(c) => (c.1, c.2.clone()),
            None => deprecation_at(&lines, start - 1),
        };
        sym.deprecated = deprecated;
        sym.deprecated_note = note;
        if sym.kind == "class" {
            sym.implements = implements_from_header(sym.signature.as_deref());
        }
    }
}

/// `@deprecated` in the JSDoc block directly above a declaration (TypeScript
/// `extractJsDocTags`): the flag, and the note after the tag when there is one.
fn deprecation_at(lines: &[&str], start: usize) -> (bool, Option<String>) {
    let lower = start.saturating_sub(8);
    let mut block = None;
    for i in (lower..start).rev() {
        let line = lines[i].trim();
        if line.starts_with("/**") {
            block = Some(i);
            break;
        }
        if !line.is_empty() && !line.starts_with("//") && !line.starts_with('*') {
            break;
        }
    }
    let Some(block) = block else { return (false, None) };
    let mut deprecated = false;
    let mut note = None;
    for line in lines.iter().take(start).skip(block) {
        let text = line.trim();
        let text = text.strip_prefix('*').unwrap_or(text);
        let text = text.strip_prefix(' ').unwrap_or(text);
        if let Some(rest) = text.strip_prefix("@deprecated") {
            deprecated = true;
            let rest = rest.trim();
            if !rest.is_empty() {
                note = Some(rest.to_string());
            }
        }
    }
    (deprecated, note)
}

/// Interface names from a class header's `implements` clause, as a JSON array string
/// (TypeScript stores `JSON.stringify(names)`). Generic arguments are dropped.
fn implements_from_header(header: Option<&str>) -> Option<String> {
    let header = header?;
    let (_, after) = header.split_once(" implements ")?;
    let names: Vec<String> = after
        .split('{')
        .next()?
        .split(',')
        .map(|part| part.split('<').next().unwrap_or("").trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    Some(serde_json::to_string(&names).ok()?)
}

/// Variables inside function bodies that hold functions. TypeScript extracts those too
/// (the same promotion rule as module-level declarations), with no container.
struct NestedVariableCollector<'s> {
    line_index: &'s [usize],
    file: &'s str,
    depth: usize,
    /// True inside an exported top-level declaration: the TypeScript index does not extract
    /// variables from there.
    in_export: bool,
    symbols: Vec<Symbol>,
}

impl<'a, 's> Visit<'a> for NestedVariableCollector<'s> {
    fn visit_function(&mut self, func: &oxc_ast::ast::Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        // Function declarations nested in a function body are symbols too.
        if self.depth > 0 && !self.in_export && func.r#type == oxc_ast::ast::FunctionType::FunctionDeclaration {
            if let Some(id) = &func.id {
                let name = id.name.as_str().to_string();
                let line = byte_to_line(self.line_index, func.span.start as usize);
                let end = byte_to_line(self.line_index, func.span.end as usize);
                self.symbols.push(Symbol {
                    name: name.clone(),
                    kind: "function".to_string(),
                    container: None,
                    signature: Some(format!("{}({})", name, params_string(&func.params))),
                    file_path: self.file.to_string(),
                    line: Some(line),
                    end_line: Some(end),
                    export: false,
                    doc_summary: None,
                    body_hash: None,
                    body_lines: None,
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: name.starts_with('_'),
                    decorators: None,
                });
            }
        }
        self.depth += 1;
        oxc_ast_visit::walk::walk_function(self, func, flags);
        self.depth -= 1;
    }

    fn visit_block_statement(&mut self, block: &oxc_ast::ast::BlockStatement<'a>) {
        // Statements in any block are dispatched by the TypeScript extractor.
        self.depth += 1;
        oxc_ast_visit::walk::walk_block_statement(self, block);
        self.depth -= 1;
    }

    fn visit_ts_type_alias_declaration(&mut self, alias: &oxc_ast::ast::TSTypeAliasDeclaration<'a>) {
        if self.depth > 0 && !self.in_export {
            let line = byte_to_line(self.line_index, alias.span.start as usize);
            let end = byte_to_line(self.line_index, alias.span.end as usize);
            let name = alias.id.name.as_str().to_string();
            self.symbols.push(Symbol {
                name: name.clone(),
                kind: "type".to_string(),
                container: None,
                signature: None,
                file_path: self.file.to_string(),
                line: Some(line),
                end_line: Some(end),
                export: false,
                doc_summary: None,
                body_hash: None,
                body_lines: None,
                structure_hash: None,
                implements: None,
                deprecated: false,
                deprecated_note: None,
                is_internal: name.starts_with('_'),
                decorators: None,
            });
        }
    }

    fn visit_statement(&mut self, stmt: &oxc_ast::ast::Statement<'a>) {
        // Only exported functions and classes hide their nested declarations; an exported
        // variable is searched like any other.
        let exported = match stmt {
            oxc_ast::ast::Statement::ExportNamedDeclaration(export) => !matches!(
                export.declaration,
                Some(oxc_ast::ast::Declaration::VariableDeclaration(_))
            ),
            oxc_ast::ast::Statement::ExportDefaultDeclaration(_) => true,
            _ => false,
        };
        let outer = self.in_export;
        self.in_export = exported || outer;
        oxc_ast_visit::walk::walk_statement(self, stmt);
        self.in_export = outer;
    }

    fn visit_arrow_function_expression(&mut self, arrow: &oxc_ast::ast::ArrowFunctionExpression<'a>) {
        self.depth += 1;
        oxc_ast_visit::walk::walk_arrow_function_expression(self, arrow);
        self.depth -= 1;
    }

    fn visit_variable_declaration(&mut self, decl: &oxc_ast::ast::VariableDeclaration<'a>) {
        if self.depth > 0 && !self.in_export {
            for declarator in decl.declarations.iter() {
                let Some(init) = &declarator.init else { continue };
                if !variable_holds_function(init) {
                    continue;
                }
                if let BindingPattern::BindingIdentifier(id) = &declarator.id {
                    let line = byte_to_line(self.line_index, declarator.span.start as usize);
                    let end = byte_to_line(self.line_index, declarator.span.end as usize);
                    self.symbols.push(Symbol {
                        name: id.name.as_str().to_string(),
                        kind: "function".to_string(),
                        container: None,
                        signature: None,
                        file_path: self.file.to_string(),
                        line: Some(line),
                        end_line: Some(end),
                        export: false,
                        doc_summary: None,
                        body_hash: None,
                        body_lines: None,
                        structure_hash: None,
                        implements: None,
                        deprecated: false,
                        deprecated_note: None,
                        is_internal: id.name.starts_with('_'),
                        decorators: None,
                    });
                }
            }
        }
        oxc_ast_visit::walk::walk_variable_declaration(self, decl);
    }
}

/// TypeScript promotes a variable to a function when its value is a function, or a call with
/// a function argument, directly.
fn variable_holds_function(init: &Expression<'_>) -> bool {
    match init {
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => true,
        Expression::CallExpression(call) => call.arguments.iter().any(|arg| {
            matches!(
                arg,
                oxc_ast::ast::Argument::ArrowFunctionExpression(_)
                    | oxc_ast::ast::Argument::FunctionExpression(_)
            )
        }),
        _ => false,
    }
}

/// Signature of a declaration, as the TypeScript AX stage records it: the header text
/// from the declaration's first line, up to `{`. Only interfaces, classes, functions and
/// methods carry one; properties and type aliases do not.
fn apply_declaration_headers(symbols: &mut [Symbol], content: &str) {
    let lines: Vec<&str> = content.lines().collect();
    for sym in symbols.iter_mut() {
        if !matches!(sym.kind.as_str(), "interface" | "class" | "function" | "method") {
            continue;
        }
        // A function promoted from a variable carries no signature in the index.
        if sym.kind == "function" && sym.signature.is_none() {
            continue;
        }
        // Interfaces carry the constructed form `interface <Name>`, not the source header.
        if sym.kind == "interface" {
            sym.signature = Some(format!("interface {}", sym.name));
            continue;
        }
        let Some(line) = sym.line else { continue };
        let Some(text) = lines.get((line as usize).saturating_sub(1)) else { continue };
        let header = text.split('{').next().unwrap_or("").trim();
        if !header.is_empty() {
            sym.signature = Some(header.to_string());
        }
    }
}

fn process_file(path: &Path, workspace_root: &Path) -> Option<ProcessedFile> {
    let content = std::fs::read_to_string(path).ok()?;
    let rel_path = path
        .strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let code_lines = content.lines().count() as i64;
    let (todos, rationale) = extract_todos_rationale(&content, &rel_path);
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let ret = Parser::new(&allocator, &content, source_type).parse();
    let mut extractor = FileExtractor::new(&content, &rel_path, workspace_root);
    let line_index = build_line_index(&content);
    let mut collector = calls::CallCollector::new(&content, &rel_path, &line_index);
    collector.visit_program(&ret.program);
    let mut nested = NestedVariableCollector {
        line_index: &line_index,
        file: &rel_path,
        depth: 0,
        in_export: false,
        symbols: Vec::new(),
    };
    nested.visit_program(&ret.program);
    extractor.symbols.extend(nested.symbols);
    for stmt in ret.program.body.iter() {
        extractor.visit_statement(stmt, None, false);
    }
    apply_declaration_headers(&mut extractor.symbols, &content);
    apply_source_fingerprints(&mut extractor.symbols, &content);
    extractor.calls = collector.calls;
    // SHA-256 truncated to 16 hex digits, as the TypeScript index stores it.
    let content_hash = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(content.as_bytes()))[..16].to_string()
    };
    // Files outside AX discovery keep their file row, but contribute no symbols or edges.
    // Files above the AX size limit are skipped the same way and recorded as unindexed.
    let too_large = content.len() > AX_MAX_FILE_SIZE;
    let in_scope = ax_extracts_symbols(&rel_path) && !too_large;
    Some(ProcessedFile {
        symbols: if in_scope { extractor.symbols } else { Vec::new() },
        imports: if in_scope { extractor.imports } else { Vec::new() },
        calls: if in_scope { extractor.calls } else { Vec::new() },
        todos: if in_scope { todos } else { Vec::new() },
        rationale: if in_scope { rationale } else { Vec::new() },
        file_entry: FileEntry {
            path: rel_path,
            last_modified: None,
            churn: 0,
            is_hotspot: false,
            primary_owner: None,
            bus_factor: None,
            is_doc: false,
            content_hash: Some(content_hash),
            doc_group: None,
            indexed: !too_large,
            skip_reason: too_large.then(|| {
                format!(
                    "file too large ({} bytes > {} bytes)",
                    content.len(),
                    AX_MAX_FILE_SIZE
                )
            }),
            comment_lines: None,
            code_lines: Some(code_lines),
        },
    })
}

fn collect_source_paths(opts: &BuildOpts) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for base in &opts.paths {
        // hidden(false) so that .github/ and other dot-directories are included.
        // Mirrors the TypeScript discoverFilesRecursive() walker behaviour.
        for entry in WalkBuilder::new(base).hidden(false).build() {
            match entry {
                Ok(e) => {
                    if e.file_type().map(|ft| ft.is_file()).unwrap_or(false)
                        && is_source_file(e.path())
                    {
                        paths.push(e.into_path());
                    }
                }
                Err(e) => eprintln!("[ax] walk error: {e}"),
            }
        }
    }
    Ok(paths)
}

pub fn run(opts: &BuildOpts) -> Result<AxResult> {
    let source_paths = collect_source_paths(opts)?;
    if opts.verbose {
        eprintln!("[ax] found {} source files", source_paths.len());
    }
    let workspace_root = opts.root.clone();
    let results: Vec<ProcessedFile> = source_paths
        .par_iter()
        .filter_map(|path| process_file(path, &workspace_root))
        .collect();
    let mut ax = AxResult::default();
    for r in results {
        ax.symbols.extend(r.symbols);
        ax.imports.extend(r.imports);
        ax.calls.extend(r.calls);
        ax.todos.extend(r.todos);
        ax.rationale.extend(r.rationale);
        ax.files.push(r.file_entry);
    }
    if opts.verbose {
        eprintln!(
            "[ax] {} symbols, {} imports, {} calls, {} todos",
            ax.symbols.len(),
            ax.imports.len(),
            ax.calls.len(),
            ax.todos.len()
        );
    }
    Ok(ax)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_and_extract(content: &'static str, path: &str) -> FileExtractor<'static> {
        let allocator: &'static Allocator = Box::leak(Box::new(Allocator::default()));
        let source_type = SourceType::from_path(Path::new(path)).unwrap_or_default();
        let ret = Parser::new(allocator, content, source_type).parse();
        let mut ex = FileExtractor::new(content, path, Path::new("."));
        for stmt in ret.program.body.iter() {
            ex.visit_statement(stmt, None, false);
        }
        ex
    }

    #[test]
    fn extracts_function_symbol() {
        let ex = parse_and_extract(
            "export function greet(name: string) { return name; }",
            "test.ts",
        );
        let sym = ex.symbols.iter().find(|s| s.name == "greet");
        assert!(sym.is_some(), "should extract greet");
        assert_eq!(sym.unwrap().kind, "function");
        assert!(sym.unwrap().export);
    }

    #[test]
    fn extracts_class_symbol() {
        let ex = parse_and_extract("export class AuthService {}", "test.ts");
        let sym = ex.symbols.iter().find(|s| s.name == "AuthService");
        assert!(sym.is_some());
        assert_eq!(sym.unwrap().kind, "class");
    }

    #[test]
    fn extracts_interface_symbol() {
        let ex = parse_and_extract(
            "export interface Config { port: number; }",
            "test.ts",
        );
        let sym = ex.symbols.iter().find(|s| s.name == "Config");
        assert!(sym.is_some());
        assert_eq!(sym.unwrap().kind, "interface");
    }

    #[test]
    fn extracts_import() {
        let ex = parse_and_extract("import { foo, bar } from './utils';", "test.ts");
        assert_eq!(ex.imports.len(), 1);
        assert_eq!(ex.imports[0].module_specifier, "./utils");
        assert!(ex.imports[0].is_relative);
    }

    #[test]
    fn extracts_todo_comment() {
        let (todos, _) =
            extract_todos_rationale("// TODO: fix this later\nconst x = 1;", "src/foo.ts");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].kind, "TODO");
        assert_eq!(todos[0].line, 1);
    }

    #[test]
    fn is_source_file_detects_ts_js() {
        assert!(is_source_file(Path::new("foo.ts")));
        assert!(is_source_file(Path::new("bar.tsx")));
        assert!(is_source_file(Path::new("baz.js")));
        assert!(!is_source_file(Path::new("README.md")));
        assert!(!is_source_file(Path::new("data.json")));
    }

    #[test]
    fn resolve_relative_import() {
        let (target, is_rel) = resolve_specifier("src/auth/service.ts", "./utils");
        assert!(is_rel);
        assert_eq!(target, "src/auth/utils");
    }

    #[test]
    fn resolve_external_import() {
        let (target, is_rel) = resolve_specifier("src/auth.ts", "express");
        assert!(!is_rel);
        assert_eq!(target, "express");
    }
}

#[cfg(test)]
pub(crate) fn test_symbol(name: &str, kind: &str, container: Option<&str>, signature: Option<&str>, line: Option<i64>) -> crate::types::Symbol {
    crate::types::Symbol {
        name: name.to_string(),
        kind: kind.to_string(),
        container: container.map(str::to_string),
        signature: signature.map(str::to_string),
        file_path: "src/a.ts".to_string(),
        line,
        end_line: line,
        export: false,
        doc_summary: None,
        body_hash: None,
        body_lines: None,
        structure_hash: None,
        implements: None,
        deprecated: false,
        deprecated_note: None,
        is_internal: false,
        decorators: None,
    }
}

#[cfg(test)]
mod declaration_header_tests {
    use super::{apply_declaration_headers, test_symbol};

    #[test]
    fn header_is_the_declaration_up_to_the_brace() {
        let content = "export interface Extractor {\n  name: string;\n}\nexport function f(a: number): number {\n}\n";
        let mut symbols = vec![
            test_symbol("Extractor", "interface", None, None, Some(1)),
            test_symbol("f", "function", None, Some("f(a: number)"), Some(4)),
            test_symbol("g", "function", None, None, Some(4)),
            test_symbol("name", "property", Some("Extractor"), None, Some(2)),
        ];
        apply_declaration_headers(&mut symbols, content);
        assert_eq!(symbols[0].signature.as_deref(), Some("interface Extractor"));
        assert_eq!(symbols[1].signature.as_deref(), Some("export function f(a: number): number"));
        // A function promoted from a variable has no signature in the index.
        assert_eq!(symbols[2].signature, None);
        assert_eq!(symbols[3].signature, None);
    }
}

#[cfg(test)]
mod string_literal_tests {
    use super::replace_string_literals;

    #[test]
    fn literals_are_replaced_and_escapes_respected() {
        assert_eq!(replace_string_literals(r#"a = "x"; b = 'y\'z';"#), r#"a = "S"; b = "S";"#);
        assert_eq!(replace_string_literals("c = `t`"), r#"c = "S""#);
        assert_eq!(replace_string_literals("open 'never"), "open 'never");
    }
}
