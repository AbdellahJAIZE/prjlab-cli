const assert = require("node:assert/strict");
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const spec = require("./openapi.json");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validators = new Map();
const definitions = JSON.parse(
  JSON.stringify(spec.components.schemas).replaceAll(
    "#/components/schemas/",
    "#/$defs/",
  ),
);
for (const name of Object.keys(definitions)) {
  validators.set(
    name,
    ajv.compile({ $ref: `#/$defs/${name}`, $defs: definitions }),
  );
}
function validate(name, value) {
  const check = validators.get(name);
  assert.ok(check, `Unknown contract schema: ${name}`);
  assert.ok(check(value), `${name}: ${ajv.errorsText(check.errors)}`);
}
function matchOperation(method, pathname) {
  const path = pathname.split("?")[0];
  for (const [template, methods] of Object.entries(spec.paths)) {
    const pattern = new RegExp(
      "^" + template.replace(/\{[^}]+\}/g, "[^/]+") + "/?$",
    );
    if (pattern.test(path) && methods[method.toLowerCase()])
      return methods[method.toLowerCase()];
  }
  throw new Error(`Undocumented operation: ${method} ${path}`);
}
function response(method, pathname, status, value, input) {
  const operation = matchOperation(method, pathname);
  const definition = operation.responses[String(status)];
  assert.ok(
    definition,
    `Undocumented status ${status} for ${operation.operationId}`,
  );
  const schema = definition.content?.["application/json"]?.schema;
  if (schema) validate(schema.$ref.split("/").at(-1), value);
  else
    assert.ok(
      value === undefined || value === "",
      "No-content response has a body",
    );
  if (status < 400 && operation.requestBody) {
    validate(
      operation.requestBody.content["application/json"].schema.$ref
        .split("/")
        .at(-1),
      input,
    );
  }
}
module.exports = { spec, validate, response, matchOperation };
