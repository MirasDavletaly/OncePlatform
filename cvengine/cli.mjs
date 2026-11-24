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

const ops = {
  parse: () => ({ profile: parse(req.text, !!req.ocr) }),
  refresh: () => ({ profile: refresh(req.profile || {}) }),
  match: () => ({ roles: match(req.roles, req.candidates) }),
  meta: () => meta(),
  document: () => readDocument(req.text, req.candidates || []),
  documents: () => ({ profile: applyDocuments(req.profile, req.docs || []) }),
  person: () => ({ match: samePerson(req.profile, req.candidates || []) }),
};
if (!ops[req.op]) {
  process.stderr.write(`unknown op ${req.op}\n`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(ops[req.op]()));
