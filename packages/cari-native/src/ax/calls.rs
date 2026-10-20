//! Call-edge extraction for the `symbol_calls` table, ported from the TypeScript
//! extractor (`extractUsages` / `extractCall` / `findEnclosingSymbol`).
//!
//! Every call expression is recorded. A plain identifier callee has no callee id; a
//! static member callee has the dotted chain of its receiver, or none when the chain
//! contains a computed part. The caller is the nearest enclosing function, found the way
//! the TypeScript extractor finds it: a declaration by name, an arrow or function
//! expression only when assigned to a variable or set as an object or class value, and
//! `None` otherwise (including module level).

use oxc_ast::ast::{
    ArrowFunctionExpression, CallExpression, Expression, Function, FunctionType,
    MethodDefinition, ObjectProperty, VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;

use crate::types::SymbolCall;

pub(crate) struct CallCollector<'s> {
    content: &'s str,
    file: &'s str,
    line_index: &'s [usize],
    /// One frame per enclosing function-like node; `None` means "no caller name".
    frames: Vec<Option<String>>,
    /// Name the next function-like node takes from its context (variable, object key,
    /// or class member), consumed on entry.
    pending: Option<Option<String>>,
    pub calls: Vec<SymbolCall>,
    /// Start offset of a generic call the TypeScript grammar does not parse as a call
    /// (`await f<T>(…)`, read as a comparison). It is not recorded, to match the index.
    skip_call_at: Option<u32>,
}

impl<'s> CallCollector<'s> {
    pub(crate) fn new(content: &'s str, file: &'s str, line_index: &'s [usize]) -> Self {
        Self {
            content,
            file,
            line_index,
            frames: Vec::new(),
            pending: None,
            calls: Vec::new(),
            skip_call_at: None,
        }
    }

    fn line(&self, byte: u32) -> i64 {
        crate::ax::byte_to_line(self.line_index, byte as usize)
    }

    fn text(&self, span: oxc_span::Span) -> String {
        self.content
            .get(span.start as usize..span.end as usize)
            .unwrap_or("")
            .to_string()
    }

    fn caller(&self) -> Option<String> {
        self.frames.last().cloned().flatten()
    }

    fn expression_is_function(expr: &Expression<'_>) -> bool {
        matches!(
            expr,
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
        )
    }
}

/// Dotted chain of a callee receiver: identifiers and `this`, joined by `.`. Any other
/// shape makes the whole chain unknown (`?`), as in the TypeScript extractor.
fn member_chain(expr: &Expression<'_>, content: &str) -> String {
    match expr {
        Expression::Identifier(id) => id.name.as_str().to_string(),
        Expression::ThisExpression(_) => "this".to_string(),
        Expression::StaticMemberExpression(m) => {
            let base = member_chain(&m.object, content);
            if base == "?" {
                "?".to_string()
            } else {
                format!("{base}.{}", m.property.name.as_str())
            }
        }
        _ => {
            let _ = content;
            "?".to_string()
        }
    }
}

impl<'a, 's> Visit<'a> for CallCollector<'s> {
    fn visit_await_expression(&mut self, expr: &oxc_ast::ast::AwaitExpression<'a>) {
        if let Expression::CallExpression(call) = &expr.argument {
            if call.type_arguments.is_some()
                && matches!(
                    call.callee,
                    Expression::Identifier(_) | Expression::StaticMemberExpression(_)
                )
            {
                self.skip_call_at = Some(call.span.start);
            }
        }
        walk::walk_await_expression(self, expr);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.skip_call_at == Some(call.span.start) {
            walk::walk_call_expression(self, call);
            return;
        }
        let line = self.line(call.span.start);
        let caller_name = self.caller();
        match &call.callee {
            Expression::Identifier(id) => {
                self.calls.push(SymbolCall {
                    caller_file: self.file.to_string(),
                    caller_name,
                    caller_line: line,
                    callee_name: id.name.as_str().to_string(),
                    callee_id: None,
                    is_method: false,
                });
            }
            Expression::StaticMemberExpression(m) => {
                let chain = member_chain(&m.object, self.content);
                let callee_id = if chain == "?" {
                    None
                } else {
                    Some(format!("{chain}.{}", m.property.name.as_str()))
                };
                self.calls.push(SymbolCall {
                    caller_file: self.file.to_string(),
                    caller_name,
                    caller_line: line,
                    callee_name: m.property.name.as_str().to_string(),
                    callee_id,
                    is_method: true,
                });
            }
            _ => {}
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_function(&mut self, func: &Function<'a>, flags: oxc_syntax::scope::ScopeFlags) {
        let name = if func.r#type == FunctionType::FunctionDeclaration {
            self.pending = None;
            func.id.as_ref().map(|id| id.name.as_str().to_string())
        } else {
            self.pending.take().unwrap_or(None)
        };
        self.frames.push(name);
        walk::walk_function(self, func, flags);
        self.frames.pop();
    }

    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        let name = self.pending.take().unwrap_or(None);
        self.frames.push(name);
        walk::walk_arrow_function_expression(self, arrow);
        self.frames.pop();
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let (Some(init), Some(id)) = (&declarator.init, declarator.id.get_binding_identifier()) {
            if Self::expression_is_function(init) {
                self.pending = Some(Some(id.name.as_str().to_string()));
            }
        }
        walk::walk_variable_declarator(self, declarator);
        self.pending = None;
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
        if Self::expression_is_function(&property.value) {
            let key = self.text(property.key.span());
            self.pending = Some(Some(key));
        }
        walk::walk_object_property(self, property);
        self.pending = None;
    }

    fn visit_method_definition(&mut self, method: &MethodDefinition<'a>) {
        let key = self.text(method.key.span());
        self.pending = Some(Some(key));
        walk::walk_method_definition(self, method);
        self.pending = None;
    }
}
