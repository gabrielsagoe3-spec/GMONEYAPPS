import {PROJECT_URL,PUBLISHABLE_KEY,readToken} from './runtime.mjs';

export class ConnectorApi {
  constructor({token,fetchImpl=fetch}={}) {this.token=token ?? readToken();this.fetch=fetchImpl;}
  async call(action,payload={}) {
    let response;
    try {response=await this.fetch(PROJECT_URL+'/rest/v1/rpc/application_connector_rpc',{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{apikey:PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_token:this.token,p_action:action,p_payload:payload})});}
    catch {throw Error('The private connector API could not be reached. No server response was confirmed.');}
    if(!response.ok)throw Error('The private connector API rejected the request (HTTP '+response.status+'). Check credential expiry and the workspace status.');
    const reader=response.body?.getReader();if(!reader)throw Error('The connector API returned an empty response.');
    const chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('The connector API response exceeded the allowed size.');}chunks.push(value);}
    try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch {throw Error('The connector API returned an invalid response.');}
  }
}
