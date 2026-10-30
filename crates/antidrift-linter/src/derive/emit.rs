use std::fs;
use std::path::Path;

use serde::Serialize;

use super::contracts::{InjectedParam, MethodContract, PublicationContract, WireParam};
use super::route_contracts::RouteContract;
use super::wire_shape::{WireField, WireLiteral, WireShape};
use super::{DeriveDiagnostic, DeriveReport};

#[derive(Serialize)]
struct Manifest<'a> {
    methods: &'a [MethodContract],
    publications: &'a [PublicationContract],
    routes: &'a [RouteContract],
}

#[derive(Serialize)]
struct DiagnosticsFile<'a> {
    diagnostics: &'a [DeriveDiagnostic],
}

pub(crate) fn write_generated(dir: &Path, report: &DeriveReport) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
    let manifest = serde_json::to_string_pretty(&Manifest {
        methods: &report.methods,
        publications: &report.publications,
        routes: &report.routes,
    })
    .map_err(|err| format!("manifest is not serializable: {err}"))?;
    let diagnostics = serde_json::to_string_pretty(&DiagnosticsFile {
        diagnostics: &report.diagnostics,
    })
    .map_err(|err| format!("derive report is not serializable: {err}"))?;
    let outputs = [
        ("wire.ts", wire_module(report)),
        ("client.ts", client_module(report)),
        ("server.ts", server_module(report)),
        ("manifest.json", manifest),
        ("derive-report.json", diagnostics),
    ];
    for (name, content) in outputs {
        let path = dir.join(name);
        fs::write(&path, format!("{content}\n"))
            .map_err(|err| format!("cannot write {}: {err}", path.display()))?;
    }
    Ok(())
}

fn pascal(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn module_specifier(file: &str) -> String {
    let stem = file
        .strip_suffix(".tsx")
        .or_else(|| file.strip_suffix(".ts"))
        .unwrap_or(file);
    format!("../{stem}")
}

fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_' || rest == '$')
}

fn js_key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        js_string(name)
    }
}

fn literal_js(value: &WireLiteral) -> String {
    match value {
        WireLiteral::Text(text) => js_string(text),
        WireLiteral::Number(number) => format!("{number}"),
        WireLiteral::Flag(flag) => format!("{flag}"),
    }
}

#[derive(Clone, Copy)]
struct Site<'a> {
    raw: &'a str,
    path: &'a str,
    depth: usize,
}

fn decoder_expr(shape: &WireShape, site: Site<'_>) -> String {
    let Site { raw, path, .. } = site;
    match shape {
        WireShape::String => format!("expectString({raw}, {path})"),
        WireShape::Number => format!("expectNumber({raw}, {path})"),
        WireShape::Boolean => format!("expectBoolean({raw}, {path})"),
        WireShape::Null => format!("expectNull({raw}, {path})"),
        WireShape::Date => format!("expectDate({raw}, {path})"),
        WireShape::Literal { value } => {
            format!("expectLiteral({raw}, {path}, {})", literal_js(value))
        }
        WireShape::Array { items } => array_expr(items, site),
        WireShape::Object { fields } => object_expr(fields, site),
        WireShape::Union { variants } => union_expr(variants, site),
    }
}

fn array_expr(items: &WireShape, site: Site<'_>) -> String {
    let item = format!("item{}", site.depth);
    let item_path = format!("itemPath{}", site.depth);
    let inner = decoder_expr(
        items,
        Site {
            raw: &item,
            path: &item_path,
            depth: site.depth + 1,
        },
    );
    format!(
        "expectArray({}, {}, ({item}, {item_path}) => {inner})",
        site.raw, site.path
    )
}

fn template_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
}

fn child_path(parent: &str, field: &str) -> String {
    let field = template_text(field);
    match parent
        .strip_prefix('`')
        .and_then(|rest| rest.strip_suffix('`'))
    {
        Some(template) => format!("`{template}.{field}`"),
        None => format!("`${{{parent}}}.{field}`"),
    }
}

fn field_entry(field: &WireField, record: &str, site: Site<'_>) -> String {
    let access = format!("{record}[{}]", js_string(&field.name));
    let field_path = child_path(site.path, &field.name);
    let inner = decoder_expr(
        &field.shape,
        Site {
            raw: &access,
            path: &field_path,
            depth: site.depth + 1,
        },
    );
    let key = js_key(&field.name);
    if field.optional {
        format!("...({access} === undefined ? {{}} : {{ {key}: {inner} }})")
    } else {
        format!("{key}: {inner}")
    }
}

fn object_expr(fields: &[WireField], site: Site<'_>) -> String {
    let record = format!("record{}", site.depth);
    let entries: Vec<String> = fields
        .iter()
        .map(|field| field_entry(field, &record, site))
        .collect();
    format!(
        "expectObject({}, {}, ({record}) => ({{ {} }}))",
        site.raw,
        site.path,
        entries.join(", ")
    )
}

fn union_expr(variants: &[WireShape], site: Site<'_>) -> String {
    let raw = format!("raw{}", site.depth);
    let path = format!("path{}", site.depth);
    let arms: Vec<String> = variants
        .iter()
        .map(|variant| {
            let inner = decoder_expr(
                variant,
                Site {
                    raw: &raw,
                    path: &path,
                    depth: site.depth + 1,
                },
            );
            format!("({raw}, {path}) => {inner}")
        })
        .collect();
    format!(
        "firstOf({}, {}, [{}])",
        site.raw,
        site.path,
        arms.join(", ")
    )
}

fn decoder_const(type_name: &str, shape: &WireShape) -> String {
    let expr = decoder_expr(
        shape,
        Site {
            raw: "raw",
            path: "path",
            depth: 0,
        },
    );
    format!("export const decode{type_name}: Decoder<{type_name}> = (raw, path) =>\n  {expr};")
}

fn param_type_names(contract_name: &str, params: &[WireParam]) -> Vec<String> {
    (0..params.len())
        .map(|index| format!("{}Arg{index}", pascal(contract_name)))
        .collect()
}

const DECODE_HELPERS: &[&str] = &[
    "expectArray",
    "expectBoolean",
    "expectDate",
    "expectLiteral",
    "expectNull",
    "expectNumber",
    "expectObject",
    "expectString",
    "firstOf",
];

fn owner_import(name: &str, file: &str) -> String {
    format!(
        "import type {{ {name} }} from {};",
        js_string(&module_specifier(file))
    )
}

fn push_param_decoders(body: &mut Vec<String>, contract_name: &str, params: &[WireParam]) {
    for (index, (type_name, param)) in param_type_names(contract_name, params)
        .iter()
        .zip(params)
        .enumerate()
    {
        body.push(format!(
            "\nexport type {type_name} = Parameters<typeof {contract_name}>[{index}];"
        ));
        body.push(decoder_const(type_name, &param.shape));
    }
}

fn wire_module(report: &DeriveReport) -> String {
    let mut owners = Vec::new();
    let mut body = Vec::new();
    for method in &report.methods {
        owners.push(owner_import(&method.name, &method.file));
        push_param_decoders(&mut body, &method.name, &method.params);
        let result_name = format!("{}Result", pascal(&method.name));
        body.push(format!(
            "\nexport type {result_name} = Awaited<ReturnType<typeof {}>>;",
            method.name
        ));
        body.push(decoder_const(&result_name, &method.result));
    }
    for publication in &report.publications {
        owners.push(owner_import(&publication.name, &publication.file));
        push_param_decoders(&mut body, &publication.name, &publication.params);
        let yield_name = format!("{}Yield", pascal(&publication.name));
        body.push(format!(
            "\nexport type {yield_name} = YieldOf<ReturnType<typeof {}>>;",
            publication.name
        ));
        body.push(decoder_const(&yield_name, &publication.yields));
    }
    let body_text = body.join("\n");
    let helpers: Vec<&str> = DECODE_HELPERS
        .iter()
        .copied()
        .filter(|helper| body_text.contains(&format!("{helper}(")))
        .collect();
    let runtime_types: Vec<&str> = [
        (!body.is_empty()).then_some("Decoder"),
        (!report.publications.is_empty()).then_some("YieldOf"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut header = Vec::new();
    if !helpers.is_empty() {
        header.push(format!(
            "import {{ {} }} from \"../runtime/decode\";",
            helpers.join(", ")
        ));
    }
    if !runtime_types.is_empty() {
        header.push(format!(
            "import type {{ {} }} from \"../runtime/decode\";",
            runtime_types.join(", ")
        ));
    }
    header.extend(owners);
    format!("{}\n{body_text}", header.join("\n"))
}

fn signature_params(contract_name: &str, params: &[WireParam]) -> String {
    param_type_names(contract_name, params)
        .iter()
        .zip(params)
        .map(|(type_name, param)| format!("{}: {type_name}", param.name))
        .collect::<Vec<String>>()
        .join(", ")
}

fn client_module(report: &DeriveReport) -> String {
    let mut lines =
        vec!["import { callMethod, subscribePub } from \"../runtime/client\";".to_owned()];
    let mut decoders = Vec::new();
    let mut types = Vec::new();
    for method in &report.methods {
        types.extend(param_type_names(&method.name, &method.params));
        types.push(format!("{}Result", pascal(&method.name)));
        decoders.push(format!("decode{}Result", pascal(&method.name)));
    }
    for publication in &report.publications {
        types.extend(param_type_names(&publication.name, &publication.params));
        types.push(format!("{}Yield", pascal(&publication.name)));
        decoders.push(format!("decode{}Yield", pascal(&publication.name)));
    }
    if !decoders.is_empty() {
        lines.push(format!(
            "import {{ {} }} from \"./wire\";",
            decoders.join(", ")
        ));
        lines.push(format!(
            "import type {{ {} }} from \"./wire\";",
            types.join(", ")
        ));
    }
    for method in &report.methods {
        let args: Vec<&str> = method
            .params
            .iter()
            .map(|param| param.name.as_str())
            .collect();
        lines.push(format!(
            "\nexport function {name}({params}): Promise<{result}> {{\n  return callMethod({wire_name}, [{args}], decode{result});\n}}",
            name = method.name,
            params = signature_params(&method.name, &method.params),
            result = format!("{}Result", pascal(&method.name)),
            wire_name = js_string(&method.name),
            args = args.join(", ")
        ));
    }
    for publication in &report.publications {
        let args: Vec<&str> = publication
            .params
            .iter()
            .map(|param| param.name.as_str())
            .collect();
        lines.push(format!(
            "\nexport function {name}({params}): AsyncGenerator<{yields}> {{\n  return subscribePub({wire_name}, [{args}], decode{yields});\n}}",
            name = publication.name,
            params = signature_params(&publication.name, &publication.params),
            yields = format!("{}Yield", pascal(&publication.name)),
            wire_name = js_string(&publication.name),
            args = args.join(", ")
        ));
    }
    lines.join("\n")
}

fn call_args(contract_name: &str, params: &[WireParam], injected: &[InjectedParam]) -> String {
    let mut args: Vec<String> = param_type_names(contract_name, params)
        .iter()
        .enumerate()
        .map(|(index, type_name)| format!("decode{type_name}(args[{index}], \"args[{index}]\")"))
        .collect();
    for kind in injected {
        args.push(
            match kind {
                InjectedParam::Session => "session",
                InjectedParam::AbortSignal => "signal",
            }
            .to_owned(),
        );
    }
    args.join(", ")
}

fn server_module(report: &DeriveReport) -> String {
    let mut lines = vec![
        "import type { Session } from \"../shared/session\";".to_owned(),
        "import type { DispatchTable, MethodInvoker, PubInvoker, RouteEntry } from \"../runtime/server\";".to_owned(),
    ];
    let mut decoders = Vec::new();
    for method in &report.methods {
        decoders.extend(
            param_type_names(&method.name, &method.params)
                .iter()
                .map(|type_name| format!("decode{type_name}")),
        );
    }
    for publication in &report.publications {
        decoders.extend(
            param_type_names(&publication.name, &publication.params)
                .iter()
                .map(|type_name| format!("decode{type_name}")),
        );
    }
    if !decoders.is_empty() {
        lines.push(format!(
            "import {{ {} }} from \"./wire\";",
            decoders.join(", ")
        ));
    }
    lines.push("\nconst methods = {".to_owned());
    for method in &report.methods {
        lines.push(format!(
            "  {name}: async (args: readonly unknown[], session: Session): Promise<unknown> => {{\n    const {{ {name} }} = await import({spec});\n    return {name}({call});\n  }},",
            name = method.name,
            spec = js_string(&module_specifier(&method.file)),
            call = call_args(&method.name, &method.params, &method.injected)
        ));
    }
    lines.push("} satisfies Record<string, MethodInvoker>;".to_owned());
    lines.push("\nconst pubs = {".to_owned());
    for publication in &report.publications {
        lines.push(format!(
            "  {name}: async function* (args: readonly unknown[], session: Session, signal: AbortSignal): AsyncGenerator {{\n    const {{ {name} }} = await import({spec});\n    yield* {name}({call});\n  }},",
            name = publication.name,
            spec = js_string(&module_specifier(&publication.file)),
            call = call_args(&publication.name, &publication.params, &publication.injected)
        ));
    }
    lines.push("} satisfies Record<string, PubInvoker>;".to_owned());
    lines.push("\nconst routes: readonly RouteEntry[] = [".to_owned());
    for route in &report.routes {
        lines.push(format!(
            "  {{ pattern: {pattern}, load: () => import({spec}) }},",
            pattern = js_string(&route.pattern),
            spec = js_string(&module_specifier(&route.file))
        ));
    }
    lines.push("];".to_owned());
    lines.push("\nexport const table: DispatchTable = { methods, pubs, routes };".to_owned());
    lines.join("\n")
}
