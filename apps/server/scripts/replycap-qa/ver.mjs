import { local } from './lib.mjs';
const v = await local('qa-viewer');
const d = (await v.api('GET','/api/v1/databases')).json.databases.map(d=>({id:d.id,ver:d.server?.version,mode:d.server?.mode,role:d.effectiveRole,ro:d.readOnly}));
console.log(d);
