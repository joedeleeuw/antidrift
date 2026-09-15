type Settings = { enabled: boolean };
declare const text: string;
let settings: Settings = { enabled: false };
settings = JSON.parse(text);
const direct: Settings = JSON.parse(text);
const raw = JSON.parse(text);
const alias = raw;
const indirect: Settings = alias;
function readSettings(): Settings {
  return JSON.parse(text);
}
const asserted = JSON.parse(text) as Settings;
export { settings, direct, indirect, readSettings, asserted };
