import { getScenario } from "../src/lib/forge/repo";
getScenario("editor-test-mvjeycxb").then((s) => { console.log(JSON.stringify(s, null, 1).slice(0, 6000)); process.exit(0); }).catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
