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
    BindingPattern, ClassElement, Declaration, ExportDefaultDeclarationKind,
    ImportDeclarationSpecifier, MethodDefinitionKind, PropertyKey, Statement,
    TSAccessibility, TSModuleDeclarationName, TSSignature,
};
use oxc_parser::Parser;
use oxc_span::SourceType;
use rayon::prelude::*;
use std::path::{Path, PathBuf};

use crate::types::{AxResult, BuildOpts, FileEntry, Import, Rationale, Symbol, SymbolCall, Todo};

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

fn build_line_index(text: &str) -> Vec<usize> {
    let mut idx = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            idx.push(i + 1);
        }
    }
    idx
}

fn byte_to_line(line_idx: &[usize], byte_pos: usize) -> i64 {
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
    line_idx: Vec<usize>,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub calls: Vec<SymbolCall>,
}

impl<'s> FileExtractor<'s> {
    fn new(content: &'s str, rel_path: &str) -> Self {
        Self {
            content,
            rel_path: rel_path.to_string(),
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
                    self.walk_body_for_calls(func.body.as_deref(), Some(name));
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
                let name = match &module.id {
                    TSModuleDeclarationName::Identifier(id) => id.name.as_str().to_string(),
                    TSModuleDeclarationName::StringLiteral(s) => s.value.as_str().to_string(),
                };
                self.push_symbol(Symbol {
                    name: name.clone(),
                    kind: "namespace".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(module.span.start)),
                    end_line: Some(self.line(module.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: None,
                    body_lines: None,
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: false,
                    decorators: None,
                });
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
                    self.walk_body_for_calls(func.body.as_deref(), Some(name));
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
                if let Some(src) = &export.source {
                    let (target, is_rel) =
                        resolve_specifier(&self.rel_path, src.value.as_str());
                    self.imports.push(Import {
                        source_file: self.rel_path.clone(),
                        target_file: target,
                        module_specifier: src.value.as_str().to_string(),
                        line: Some(self.line(export.span.start)),
                        is_relative: is_rel,
                        imported_names: None,
                    });
                }
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
                        self.walk_body_for_calls(func.body.as_deref(), Some(name));
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
                let name = match &module.id {
                    TSModuleDeclarationName::Identifier(id) => id.name.as_str().to_string(),
                    TSModuleDeclarationName::StringLiteral(s) => s.value.as_str().to_string(),
                };
                self.push_symbol(Symbol {
                    name: name.clone(),
                    kind: "namespace".to_string(),
                    container: parent.map(String::from),
                    signature: None,
                    file_path: self.rel_path.clone(),
                    line: Some(self.line(module.span.start)),
                    end_line: Some(self.line(module.span.end)),
                    export: exported,
                    doc_summary: None,
                    body_hash: None,
                    body_lines: None,
                    structure_hash: None,
                    implements: None,
                    deprecated: false,
                    deprecated_note: None,
                    is_internal: false,
                    decorators: None,
                });
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
                let kind = match method.kind {
                    MethodDefinitionKind::Constructor => "constructor",
                    MethodDefinitionKind::Get => "getter",
                    MethodDefinitionKind::Set => "setter",
                    MethodDefinitionKind::Method => "method",
                };
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
                    self.walk_body_for_calls(func.body.as_deref(), Some(method_name));
                }
            } else if let ClassElement::PropertyDefinition(prop) = elem {
                if !prop.computed {
                    if let Some(prop_name) = property_key_name(&prop.key) {
                        let is_public = !matches!(
                            prop.accessibility,
                            Some(TSAccessibility::Private) | Some(TSAccessibility::Protected)
                        );
                        if is_public {
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
                        if let Some(name) = property_key_name(&prop.key) {
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
        if !exported {
            return;
        }
        for decl in var_decl.declarations.iter() {
            if let BindingPattern::BindingIdentifier(id) = &decl.id {
                let name = id.name.as_str();
                self.symbols.push(Symbol {
                    name: name.to_string(),
                    kind: "variable".to_string(),
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
        let (target, is_rel) = resolve_specifier(&self.rel_path, specifier);
        let imported_names: Vec<String> = decl
            .specifiers
            .as_ref()
            .map(|specs| {
                specs
                    .iter()
                    .map(|s| match s {
                        ImportDeclarationSpecifier::ImportSpecifier(spec) => {
                            spec.local.name.as_str().to_string()
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(spec) => {
                            spec.local.name.as_str().to_string()
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(spec) => {
                            format!("* as {}", spec.local.name.as_str())
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.imports.push(Import {
            source_file: self.rel_path.clone(),
            target_file: target,
            module_specifier: specifier.to_string(),
            line: Some(self.line(decl.span.start)),
            is_relative: is_rel,
            imported_names: if imported_names.is_empty() {
                None
            } else {
                Some(imported_names.join(", "))
            },
        });
    }

    fn walk_body_for_calls(
        &mut self,
        body: Option<&oxc_ast::ast::FunctionBody<'_>>,
        context: Option<&str>,
    ) {
        let Some(body) = body else { return };
        for stmt in body.statements.iter() {
            self.collect_calls_from_stmt(stmt, context);
        }
    }

    fn collect_calls_from_stmt(&mut self, stmt: &Statement<'_>, context: Option<&str>) {
        match stmt {
            Statement::ExpressionStatement(es) => {
                self.collect_calls_from_expr(&es.expression, context);
            }
            Statement::ReturnStatement(ret) => {
                if let Some(arg) = &ret.argument {
                    self.collect_calls_from_expr(arg, context);
                }
            }
            Statement::VariableDeclaration(var) => {
                for decl in var.declarations.iter() {
                    if let Some(init) = &decl.init {
                        self.collect_calls_from_expr(init, context);
                    }
                }
            }
            Statement::IfStatement(if_s) => {
                self.collect_calls_from_expr(&if_s.test, context);
                self.collect_calls_from_stmt(&if_s.consequent, context);
                if let Some(alt) = &if_s.alternate {
                    self.collect_calls_from_stmt(alt, context);
                }
            }
            Statement::BlockStatement(block) => {
                for s in block.body.iter() {
                    self.collect_calls_from_stmt(s, context);
                }
            }
            _ => {}
        }
    }

    fn collect_calls_from_expr(
        &mut self,
        expr: &oxc_ast::ast::Expression<'_>,
        context: Option<&str>,
    ) {
        use oxc_ast::ast::Expression;
        match expr {
            Expression::CallExpression(call) => {
                let (callee_name, callee_id, is_method) = match &call.callee {
                    Expression::Identifier(id) => {
                        (id.name.as_str().to_string(), None, false)
                    }
                    Expression::StaticMemberExpression(member) => {
                        let prop = member.property.name.as_str();
                        let obj = match &member.object {
                            Expression::Identifier(id) => id.name.as_str().to_string(),
                            _ => "(expr)".to_string(),
                        };
                        (
                            prop.to_string(),
                            Some(format!("{}.{}", obj, prop)),
                            true,
                        )
                    }
                    _ => return,
                };
                self.calls.push(SymbolCall {
                    caller_file: self.rel_path.clone(),
                    caller_name: context.unwrap_or("(module)").to_string(),
                    caller_line: self.line(call.span.start),
                    callee_name,
                    callee_id,
                    is_method,
                });
                // Recurse into arguments to find nested calls
                use oxc_ast::ast::Argument;
                for arg in call.arguments.iter() {
                    match arg {
                        Argument::SpreadElement(se) => {
                            self.collect_calls_from_expr(&se.argument, context);
                        }
                        Argument::CallExpression(nested) => {
                            // nested call as argument — record it too
                            let inner_name = match &nested.callee {
                                Expression::Identifier(id) => id.name.as_str().to_string(),
                                Expression::StaticMemberExpression(m) => {
                                    m.property.name.as_str().to_string()
                                }
                                _ => continue,
                            };
                            self.calls.push(SymbolCall {
                                caller_file: self.rel_path.clone(),
                                caller_name: context.unwrap_or("(module)").to_string(),
                                caller_line: self.line(nested.span.start),
                                callee_name: inner_name,
                                callee_id: None,
                                is_method: false,
                            });
                        }
                        _ => {}
                    }
                }
            }
            Expression::AwaitExpression(aw) => {
                self.collect_calls_from_expr(&aw.argument, context);
            }
            Expression::AssignmentExpression(assign) => {
                self.collect_calls_from_expr(&assign.right, context);
            }
            _ => {}
        }
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
    let mut extractor = FileExtractor::new(&content, &rel_path);
    for stmt in ret.program.body.iter() {
        extractor.visit_statement(stmt, None, false);
    }
    let content_hash = blake3::hash(content.as_bytes())
        .as_bytes()[..8]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    Some(ProcessedFile {
        symbols: extractor.symbols,
        imports: extractor.imports,
        calls: extractor.calls,
        todos,
        rationale,
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
            indexed: true,
            skip_reason: None,
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
        let mut ex = FileExtractor::new(content, path);
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
