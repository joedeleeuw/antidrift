use super::syntax::{Span, contains, identifier, unwrap};
use antidrift_kernel::local_binding::{
    Binding, enclosing_variable_declaration, is_const_variable_declaration, resolve_lexical_binding,
};
use antidrift_kernel::tsrs_kernel::is_function_like;
use tsrs_ast::{self as ast, Kind, Node, SourceFile};
use tsrs_core::P;

pub(super) struct Oracle {
    pub sf: P<SourceFile>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct Callback(pub(super) P<Node>);

impl Callback {
    pub(super) fn from_expression(expression: P<Node>) -> Option<Self> {
        matches!(
            expression.kind(),
            Kind::ArrowFunction | Kind::FunctionExpression
        )
        .then_some(Self(expression))
    }

    pub(super) fn id(self) -> P<Node> {
        self.0
    }

    pub(super) fn body(self) -> Option<P<Node>> {
        self.0.body().filter(|body| body.kind() == Kind::Block)
    }

    pub(super) fn span(self, sf: P<SourceFile>) -> Span {
        Span::of(sf, self.0)
    }

    pub(super) fn expression_body(self) -> Option<P<Node>> {
        if self.0.kind() != Kind::ArrowFunction {
            return None;
        }
        self.0.body().filter(|body| body.kind() != Kind::Block)
    }

    pub(super) fn direct_return(self, strict: bool) -> Option<P<Node>> {
        if let Some(expression) = self.expression_body() {
            return Some(expression);
        }
        let body = self.body()?;
        let stmts = body.as_block().statements().nodes();
        if strict && stmts.len() != 1 {
            return None;
        }
        let mut returns = stmts.iter().filter_map(|&statement| {
            (statement.kind() == Kind::ReturnStatement)
                .then(|| statement.as_return_statement().expression())
                .flatten()
        });
        let returned = returns.next()?;
        returns.next().is_none().then_some(returned)
    }

    pub(super) fn single_parameter(self) -> Option<&'static str> {
        let params = self.0.parameters();
        if params.len() != 1 {
            return None;
        }
        let param = params[0].as_parameter_declaration();
        if param.dot_dot_dot_token().is_some() {
            return None;
        }
        let name = params[0].name()?;
        ast::is_identifier(name).then(|| name.as_identifier().text())
    }
}

impl Oracle {
    pub(super) fn symbol(&self, ident: P<Node>) -> Option<Binding> {
        let _ = self;
        resolve_lexical_binding(ident)
    }

    pub(super) fn declaration(&self, ident: P<Node>) -> Option<P<Node>> {
        let binding = self.symbol(ident)?;
        (binding.decl.kind() == Kind::VariableDeclaration).then_some(binding.decl)
    }

    pub(super) fn initializer(&self, expression: P<Node>, constant: bool) -> Option<P<Node>> {
        let declaration = self.declaration(identifier(expression)?)?;
        if constant && !is_const_variable_declaration(declaration) {
            return None;
        }
        declaration.as_variable_declaration().initializer()
    }

    pub(super) fn local_initializer(
        &self,
        expression: P<Node>,
        callback: Callback,
    ) -> Option<P<Node>> {
        let declaration = self.declaration(identifier(expression)?)?;
        if self.owner(declaration) != Some(callback.id()) {
            return None;
        }
        self.initializer(expression, true)
    }

    pub(super) fn binding_source(&self, expression: P<Node>) -> Option<P<Node>> {
        let binding = self.symbol(identifier(expression)?)?;
        let declaration = enclosing_variable_declaration(binding)?;
        if let Some(initializer) = declaration.as_variable_declaration().initializer() {
            return Some(initializer);
        }
        let mut cursor = declaration.parent();
        while let Some(ancestor) = cursor {
            if ancestor.kind() == Kind::ForOfStatement {
                return Some(ancestor.as_for_in_or_of_statement().expression());
            }
            cursor = ancestor.parent();
        }
        None
    }

    pub(super) fn owner(&self, node: P<Node>) -> Option<P<Node>> {
        let _ = self;
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            if is_function_like(ancestor) {
                return Some(ancestor);
            }
            cursor = ancestor.parent();
        }
        None
    }

    pub(super) fn local_function(&self, expression: P<Node>) -> Option<Callback> {
        let ident = identifier(unwrap(expression))?;
        let binding = self.symbol(ident)?;
        match binding.decl.kind() {
            Kind::FunctionDeclaration | Kind::FunctionExpression | Kind::ArrowFunction => {
                Some(Callback(binding.decl))
            }
            Kind::VariableDeclaration => Callback::from_expression(unwrap(
                binding.decl.as_variable_declaration().initializer()?,
            )),
            _ => None,
        }
    }

    pub(super) fn import(
        &self,
        expression: P<Node>,
    ) -> Option<(&'static str, Option<&'static str>)> {
        let binding = self.symbol(identifier(expression)?)?;
        let imported = match binding.decl.kind() {
            Kind::ImportSpecifier => {
                let spec = binding.decl.as_import_specifier();
                let imported_node = spec.property_name().or_else(|| binding.decl.name())?;
                match imported_node.kind() {
                    Kind::Identifier => Some(imported_node.as_identifier().text()),
                    Kind::StringLiteral => Some(imported_node.as_string_literal().text()),
                    _ => return None,
                }
            }
            Kind::ImportClause | Kind::NamespaceImport => None,
            _ => return None,
        };
        let mut cursor = binding.decl.parent();
        while let Some(ancestor) = cursor {
            if ancestor.kind() == Kind::ImportDeclaration {
                let spec = ancestor.as_import_declaration().module_specifier();
                return ast::is_string_literal(spec)
                    .then(|| (spec.as_string_literal().text(), imported));
            }
            cursor = ancestor.parent();
        }
        None
    }

    pub(super) fn in_block(&self, node: P<Node>, callback: Callback) -> bool {
        if !contains(callback.span(self.sf), Span::of(self.sf, node)) {
            return false;
        }
        let mut cursor = node.parent();
        while let Some(ancestor) = cursor {
            if ancestor == callback.id() {
                return true;
            }
            if ancestor.kind() == Kind::CallExpression
                && super::assertions::test_callback(ancestor).is_some()
            {
                return false;
            }
            cursor = ancestor.parent();
        }
        false
    }
}
