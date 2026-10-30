use antidrift_kernel::tsrs_kernel::property_name_text;
use serde::Serialize;
use tsrs_ast::SourceFile;
use tsrs_checker::{Checker, ObjectFlags, SignatureKind, Type};
use tsrs_core::P;

use super::layout::{ExportedFunction, exported_functions, file_stem, has_non_function_exports};
use super::wire_shape::{WireShape, shape_of};
use super::{DeriveReport, DeriveRule};

#[derive(Serialize, Clone)]
pub(crate) struct WireParam {
    pub(crate) name: String,
    pub(crate) shape: WireShape,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InjectedParam {
    Session,
    AbortSignal,
}

#[derive(Serialize)]
pub(crate) struct MethodContract {
    pub(crate) name: String,
    pub(crate) file: String,
    pub(crate) params: Vec<WireParam>,
    pub(crate) injected: Vec<InjectedParam>,
    pub(crate) result: WireShape,
}

#[derive(Serialize)]
pub(crate) struct PublicationContract {
    pub(crate) name: String,
    pub(crate) file: String,
    pub(crate) params: Vec<WireParam>,
    pub(crate) injected: Vec<InjectedParam>,
    pub(crate) yields: WireShape,
}

fn single_export(
    sf: P<SourceFile>,
    relative: &str,
    noun: &str,
    report: &mut DeriveReport,
) -> Option<ExportedFunction> {
    let functions = exported_functions(sf);
    let stem = file_stem(relative);
    match functions.as_slice() {
        [single] if !has_non_function_exports(sf) => Some(*single),
        [] => {
            report.flag(
                relative,
                DeriveRule::MethodSingleExport,
                format!(
                    "exports no function declaration; a {noun} file exports exactly one `export async function {stem}` so the file name is the {noun} name on the wire."
                ),
            );
            None
        }
        _ => {
            report.flag(
                relative,
                DeriveRule::MethodSingleExport,
                format!(
                    "exports more than one declaration; a {noun} file exports exactly one `export async function {stem}`, because one file per {noun} is the unit an agent adds or replaces."
                ),
            );
            None
        }
    }
}

fn injected_param_kind(checker: &mut Checker, declared: P<Type>) -> Option<InjectedParam> {
    let name = declared
        .alias()
        .and_then(|alias| alias.symbol())
        .or_else(|| declared.symbol())
        .map(|sym| sym.name().to_owned())
        .filter(|name| name != "__type")
        .unwrap_or_else(|| checker.type_to_string_exported(declared));
    match name.as_str() {
        "Session" => Some(InjectedParam::Session),
        "AbortSignal" => Some(InjectedParam::AbortSignal),
        _ => None,
    }
}

fn wire_params(
    checker: &mut Checker,
    function: ExportedFunction,
    relative: &str,
    allowed: &[InjectedParam],
    report: &mut DeriveReport,
) -> Option<(Vec<WireParam>, Vec<InjectedParam>)> {
    let mut params = Vec::new();
    let mut injected = Vec::new();
    for &param_node in function.node.parameters() {
        let Some(name) = property_name_text(param_node.as_parameter_declaration().name()) else {
            report.flag(
                relative,
                DeriveRule::UnnamedParameter,
                format!(
                    "`{}` destructures a parameter; wire parameters need names, so take `input` and destructure inside.",
                    function.name
                ),
            );
            return None;
        };
        let declared = checker.get_type_at_location(param_node);
        if let Some(kind) = injected_param_kind(checker, declared) {
            if !allowed.contains(&kind) {
                report.flag(
                    relative,
                    DeriveRule::InjectedParamPlacement,
                    format!(
                        "`{}` asks for an injected `{kind:?}`, which this kind of export cannot receive; allowed here: {allowed:?}.",
                        function.name
                    ),
                );
                return None;
            }
            injected.push(kind);
            continue;
        }
        if !injected.is_empty() {
            report.flag(
                relative,
                DeriveRule::InjectedParamPlacement,
                format!(
                    "`{}` declares wire parameter `{name}` after an injected parameter; the runtime injects Session and AbortSignal after the wire arguments, so they come last.",
                    function.name
                ),
            );
            return None;
        }
        let param_path = format!("{}({name})", function.name);
        match shape_of(checker, declared, &param_path, 0) {
            Ok(shape) => params.push(WireParam {
                name: name.to_owned(),
                shape,
            }),
            Err(failure) => {
                report.flag(
                    relative,
                    DeriveRule::MethodParamNotWire,
                    format!("{} {}", failure.path, failure.reason),
                );
                return None;
            }
        }
    }
    Some((params, injected))
}

pub(super) fn declared_return_type(
    checker: &mut Checker,
    function: ExportedFunction,
) -> Option<P<Type>> {
    let name_node = function.node.name()?;
    let function_type = checker.get_type_at_location(name_node);
    let signature = *checker
        .get_signatures_of_type(function_type, SignatureKind::Call)
        .first()?;
    Some(checker.get_return_type_of_signature(signature))
}

fn promised_result_shape(
    checker: &mut Checker,
    function: ExportedFunction,
    relative: &str,
    report: &mut DeriveReport,
) -> Option<WireShape> {
    let Some(declared) = declared_return_type(checker, function) else {
        report.flag(
            relative,
            DeriveRule::MethodResultNotWire,
            format!(
                "`{}` has no call signature to read a result type from.",
                function.name
            ),
        );
        return None;
    };
    let Some(promised) = checker.get_promised_type_of_promise(declared) else {
        let printed = checker.type_to_string_exported(declared);
        report.flag(
            relative,
            DeriveRule::MethodResultNotWire,
            format!(
                "`{}` returns `{printed}`, which is not a Promise; an async method resolves to its wire result.",
                function.name
            ),
        );
        return None;
    };
    let result_path = format!("{}() result", function.name);
    match shape_of(checker, promised, &result_path, 0) {
        Ok(shape) => Some(shape),
        Err(failure) => {
            report.flag(
                relative,
                DeriveRule::MethodResultNotWire,
                format!("{} {}", failure.path, failure.reason),
            );
            None
        }
    }
}

pub(crate) fn inspect_method(
    checker: &mut Checker,
    sf: P<SourceFile>,
    relative: &str,
    report: &mut DeriveReport,
) {
    let Some(function) = single_export(sf, relative, "method", report) else {
        return;
    };
    if !function.is_async || function.is_generator {
        report.flag(
            relative,
            DeriveRule::MethodMustBeAsync,
            format!(
                "`{}` is not an async function; in methods/ the `async` is the network hop the client awaits, so a sync export has no wire shape. Shared sync logic belongs in shared/.",
                function.name
            ),
        );
        return;
    }
    if function.name != file_stem(relative) {
        report.flag(
            relative,
            DeriveRule::MethodExportName,
            format!(
                "exports `{}` but the file is `{}`; the file name is the method name on the wire, so rename one of them.",
                function.name,
                file_stem(relative)
            ),
        );
        return;
    }
    let Some((params, injected)) = wire_params(
        checker,
        function,
        relative,
        &[InjectedParam::Session],
        report,
    ) else {
        return;
    };
    let Some(result) = promised_result_shape(checker, function, relative, report) else {
        return;
    };
    report.methods.push(MethodContract {
        name: function.name.to_owned(),
        file: relative.to_owned(),
        params,
        injected,
        result,
    });
}

fn yield_shape(
    checker: &mut Checker,
    function: ExportedFunction,
    relative: &str,
    report: &mut DeriveReport,
) -> Option<WireShape> {
    let Some(declared) = declared_return_type(checker, function) else {
        report.flag(
            relative,
            DeriveRule::PublicationYieldNotWire,
            format!(
                "`{}` has no call signature to read a yield type from.",
                function.name
            ),
        );
        return None;
    };
    let is_async_stream = declared.object_flags().intersects(ObjectFlags::Reference)
        && declared.symbol().is_some_and(|sym| {
            matches!(
                sym.name(),
                "AsyncGenerator" | "AsyncIterable" | "AsyncIterableIterator"
            )
        });
    if !is_async_stream {
        let printed = checker.type_to_string_exported(declared);
        report.flag(
            relative,
            DeriveRule::PublicationYieldNotWire,
            format!(
                "`{}` returns `{printed}`; declare `AsyncGenerator<Patch>` so the yielded patch is the wire shape.",
                function.name
            ),
        );
        return None;
    }
    let Some(yielded) = checker.get_type_arguments(declared).first().copied() else {
        report.flag(
            relative,
            DeriveRule::PublicationYieldNotWire,
            format!("`{}` yields nothing typed.", function.name),
        );
        return None;
    };
    let yield_path = format!("{}() yield", function.name);
    match shape_of(checker, yielded, &yield_path, 0) {
        Ok(shape) => Some(shape),
        Err(failure) => {
            report.flag(
                relative,
                DeriveRule::PublicationYieldNotWire,
                format!("{} {}", failure.path, failure.reason),
            );
            None
        }
    }
}

pub(crate) fn inspect_publication(
    checker: &mut Checker,
    sf: P<SourceFile>,
    relative: &str,
    report: &mut DeriveReport,
) {
    let Some(function) = single_export(sf, relative, "publication", report) else {
        return;
    };
    if !(function.is_async && function.is_generator) {
        report.flag(
            relative,
            DeriveRule::PublicationMustBeGenerator,
            format!(
                "`{}` must be an `async function*`; a publication is a stream of typed patches and the generator is that stream.",
                function.name
            ),
        );
        return;
    }
    if function.name != file_stem(relative) {
        report.flag(
            relative,
            DeriveRule::MethodExportName,
            format!(
                "exports `{}` but the file is `{}`; the file name is the publication name on the wire.",
                function.name,
                file_stem(relative)
            ),
        );
        return;
    }
    let allowed = [InjectedParam::Session, InjectedParam::AbortSignal];
    let Some((params, injected)) = wire_params(checker, function, relative, &allowed, report)
    else {
        return;
    };
    let Some(yields) = yield_shape(checker, function, relative, report) else {
        return;
    };
    report.publications.push(PublicationContract {
        name: function.name.to_owned(),
        file: relative.to_owned(),
        params,
        injected,
        yields,
    });
}
