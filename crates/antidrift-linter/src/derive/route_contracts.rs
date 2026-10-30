use serde::Serialize;
use tsrs_ast::SourceFile;
use tsrs_checker::Checker;
use tsrs_core::P;

use super::contracts::declared_return_type;
use super::layout::{ExportedFunction, exported_functions};
use super::{DeriveReport, DeriveRule};

#[derive(Serialize)]
pub(crate) struct RouteContract {
    pub(crate) pattern: String,
    pub(crate) file: String,
    pub(crate) verbs: Vec<String>,
}

const VERBS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];

fn route_pattern(relative: &str) -> Option<String> {
    let inner = relative.strip_prefix("routes/")?.strip_suffix("route.ts")?;
    Some(format!("/{}", inner.trim_end_matches('/')))
}

fn check_route_response(
    checker: &mut Checker,
    function: ExportedFunction,
    relative: &str,
    report: &mut DeriveReport,
) {
    let promised = declared_return_type(checker, function)
        .and_then(|declared| checker.get_promised_type_of_promise(declared));
    let printed = promised.map(|typ| checker.type_to_string_exported(typ));
    if printed.as_deref() != Some("Response") {
        report.flag(
            relative,
            DeriveRule::RouteReturnType,
            format!(
                "`{}` resolves to `{}` instead of `Response`; route handlers return web-standard responses.",
                function.name,
                printed.unwrap_or_else(|| "a non-Promise".to_owned())
            ),
        );
    }
}

pub(crate) fn inspect_route(
    checker: &mut Checker,
    sf: P<SourceFile>,
    relative: &str,
    report: &mut DeriveReport,
) {
    let Some(pattern) = route_pattern(relative) else {
        report.flag(
            relative,
            DeriveRule::RouteFileName,
            "files under routes/ are named route.ts; the directory path is the URL pattern, so routes/todos/[id]/route.ts serves /todos/[id].".to_owned(),
        );
        return;
    };
    let functions = exported_functions(sf);
    let before = report.diagnostics.len();
    if functions.is_empty() {
        report.flag(
            relative,
            DeriveRule::RouteUnknownVerb,
            "exports no handler; a route file exports async GET/POST/PUT/PATCH/DELETE functions."
                .to_owned(),
        );
    }
    let mut verbs = Vec::new();
    for function in functions {
        if !VERBS.contains(&function.name) {
            report.flag(
                relative,
                DeriveRule::RouteUnknownVerb,
                format!(
                    "exports `{}`, which is not an HTTP verb; a route file exports only GET/POST/PUT/PATCH/DELETE.",
                    function.name
                ),
            );
            continue;
        }
        if !function.is_async || function.is_generator {
            report.flag(
                relative,
                DeriveRule::RouteMustBeAsync,
                format!(
                    "`{}` is not async; a route handler is `async (request: Request, session: Session, params) => Promise<Response>` and the await is the request lifecycle.",
                    function.name
                ),
            );
            continue;
        }
        check_route_response(checker, function, relative, report);
        verbs.push(function.name.to_owned());
    }
    if report.diagnostics.len() == before {
        report.routes.push(RouteContract {
            pattern,
            file: relative.to_owned(),
            verbs,
        });
    }
}
