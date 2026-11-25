// Entry point used by the Go server: one JSON request on stdin, one JSON answer on stdout.
//   {"op":"parse","text":"...","ocr":false}         -> {"profile":{...}}
//   {"op":"refresh","profile":{...}}                -> {"profile":{...}}
//   {"op":"match","roles":[...],"candidates":[...]} -> {"roles":[{"results":[...]}]}
//   {"op":"meta"}                                   -> {"professions":[...],"skills":[...],...}
//   {"op":"document","text":"...","candidates":[{id,name}]} -> {"info":{...},"match":{id,by}|null,"suggestions":[...]}
//   {"op":"documents","profile":{...},"docs":[...]} -> {"profile":{...}} (entries confirmed by the attached documents)
//   {"op":"person","profile":{...},"candidates":[{id,name,email,phone}]} -> {"match":{id,by}|null} (the same person again)
import { match, meta, parse, refresh } from './cv.js';
import { applyDocuments, readDocument, samePerson } from './cert.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
// The text comes from whoever uploads the file. A real CV is a few tens of thousands of characters, a diploma a few
// thousand: longer text is cut, so no pattern can be made to run for minutes on megabytes of crafted text.
const cap = (s, n) => String(s ?? '').slice(0, n);

const ops = {
  parse: () => ({ profile: parse(cap(req.text, 100_000), !!req.ocr) }),
  refresh: () => ({ profile: refresh(req.profile || {}) }),
  match: () => ({ roles: match(req.roles, req.candidates) }),
  meta: () => meta(),
  document: () => readDocument(cap(req.text, 40_000), req.candidates || []),
  documents: () => ({ profile: applyDocuments(req.profile, req.docs || []) }),
  person: () => ({ match: samePerson(req.profile, req.candidates || []) }),
};
if (!ops[req.op]) {
  process.stderr.write(`unknown op ${req.op}\n`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(ops[req.op]()));
