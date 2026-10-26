import {local} from './lib.mjs';
const v=await local('qa-viewer');console.log({me:(await v.api('GET','/api/v1/auth/me')).status,databases:(await v.api('GET','/api/v1/databases')).status,dbsize:(await v.cli('snapshot',['DBSIZE'])).status});
