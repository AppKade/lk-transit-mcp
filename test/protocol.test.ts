import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const entry=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
test('startup requires an explicit demo opt-in',()=>{
  const result=spawnSync(process.execPath,[entry],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,2);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/--demo/);
});
for(const modern of [false,true]) test(`stdio ${modern?'discovery':'initialize'} journey preserves synthetic provenance`,{timeout:15000},async t=>{
  const child=spawn(process.execPath,[entry,'--demo'],{stdio:['pipe','pipe','pipe']});
  const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
  let sequence=0, stderr='';
  const lines=createInterface({input:child.stdout});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  lines.on('line',line=>{
    try {const response=JSON.parse(line);const waiter=pending.get(response.id);if(waiter){pending.delete(response.id);waiter.resolve(response);}}
    catch {for(const waiter of pending.values()) waiter.reject(new Error('Non-JSON stdout'));pending.clear();}
  });
  const fail=()=>{for(const waiter of pending.values()) waiter.reject(new Error('Server exited'));pending.clear();};
  child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
  t.after(()=>{lines.close();child.kill();});
  async function request(method:string,params:Record<string,unknown>={}) {
    const id=++sequence;
    const meta=modern?{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'transit-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}:null;
    return await new Promise<any>((resolve,reject)=>{
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'));},5000);
      pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v);},reject:e=>{clearTimeout(timeout);reject(e);}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params:meta?{...params,_meta:meta}:params})+'\n');
    });
  }
  if(modern) assert.equal((await request('server/discover')).error,undefined);
  else {
    assert.equal((await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'transit-test',version:'1'}})).error,undefined);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  }
  const tools=(await request('tools/list')).result.tools;
  assert.deepEqual(tools.map((tool:any)=>tool.name).sort(),['find_stops_nearby','get_arrivals','get_feed_status','get_route','search_routes']);
  assert.ok(tools.every((tool:any)=>tool.annotations.readOnlyHint===true&&tool.annotations.openWorldHint===false));
  async function call(name:string,args:Record<string,unknown>={}) {
    const response=await request('tools/call',{name,arguments:args});assert.equal(response.error,undefined);
    const result=response.result;
    assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
    assert.equal(result.structuredContent.mode,'synthetic_demo');
    assert.equal(result.structuredContent.production_ready,false);
    assert.equal(result.structuredContent.source.type,'synthetic');
    return result;
  }
  const routes=await call('search_routes',{query:'D1'});
  assert.equal(routes.structuredContent.data[0].id,'demo:route:D1');
  const route=await call('get_route',{route_id:'demo:route:D1'});
  assert.equal(route.structuredContent.data.stops.length,3);
  assert.equal((await call('get_route',{route_id:'real:route:unknown'})).isError,true);
  const nearby=await call('find_stops_nearby',{latitude:6.9271,longitude:79.8612});
  assert.equal(nearby.structuredContent.data[0].id,'demo:stop:A');
  const arrivals=await call('get_arrivals',{stop_id:'demo:stop:A',at:'2026-10-21T07:30:00+05:30'});
  assert.equal(arrivals.structuredContent.data[0].prediction_type,'scheduled');
  assert.equal((await call('get_feed_status')).structuredContent.data.realtime.status,'unavailable');
  const invalid=await request('tools/call',{name:'find_stops_nearby',arguments:{latitude:91,longitude:0}});
  assert.ok(invalid.error||invalid.result?.isError);
  const resource=await request('resources/read',{uri:'transit://coverage'});
  assert.equal(JSON.parse(resource.result.contents[0].text).production_ready,false);
  assert.equal(stderr,'');
});
