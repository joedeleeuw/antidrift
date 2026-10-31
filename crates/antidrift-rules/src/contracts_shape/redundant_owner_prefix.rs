use antidrift_kernel::directives::split_identifier_words;
use tsrs_ast::{self as ast, Kind, Node};
use tsrs_core::P;
use tsrslint::rule::{Ctx, RuleMessage};

pub(super) fn check_redundant_owner_prefix(ctx: &mut Ctx, node: P<Node>) {
    let Some(name_node) = node.name().filter(|n| ast::is_identifier(*n)) else {
        return;
    };
    let type_name = name_node.as_identifier().text();
    let words = split_identifier_words(type_name);
    if words.len() < 2 || words[0].len() < 3 {
        return;
    }
    let stem = &words[0];
    let members = match node.kind() {
        Kind::InterfaceDeclaration => node.as_interface_declaration().members().nodes(),
        Kind::TypeAliasDeclaration => {
            let Some(type_node) = node.as_type_alias_declaration().type_() else {
                return;
            };
            if type_node.kind() != Kind::TypeLiteral {
                return;
            }
            type_node.as_type_literal_node().members().nodes()
        }
        _ => return,
    };
    if members.len() < 3 {
        return;
    }
    let all_prefixed = members.iter().all(|&member| {
        if member.kind() != Kind::PropertySignature {
            return false;
        }
        let prop_name_node = member.as_property_signature_declaration().name();
        if !ast::is_identifier(prop_name_node) {
            return false;
        }
        prop_name_node
            .as_identifier()
            .text()
            .strip_prefix(stem.as_str())
            .and_then(|rest| rest.as_bytes().first())
            .is_some_and(u8::is_ascii_uppercase)
    });
    if all_prefixed {
        ctx.report_node(
            name_node,
            RuleMessage::new(
                "redundantOwnerPrefix",
                format!(
                    "Type '{type_name}' prefixes all {} fields with '{stem}'; drop the redundant owner prefix from field names.",
                    members.len()
                ),
            ),
        );
    }
}
