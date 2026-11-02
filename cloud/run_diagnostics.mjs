import path from "node:path";
import {fileURLToPath} from "node:url";
import {readJson,writeJson} from "./storage.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const file=path.join(root,"data/run-diagnostics.json");
const old=readJson(file,{runs:[]});
const row={observedAt:new Date().toISOString(),id:process.env.GITHUB_RUN_ID||"local",event:process.env.GITHUB_EVENT_NAME||"local",cron:"2-59/5 * * * *"};
try{
  const repo=process.env.GITHUB_REPOSITORY;
  if(repo&&process.env.GITHUB_RUN_ID){
    const response=await fetch("https://api.github.com/repos/"+repo+"/actions/runs/"+row.id,{headers:{Accept:"application/vnd.github+json",...(process.env.GH_TOKEN?{Authorization:"Bearer "+process.env.GH_TOKEN}:{})},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error("GitHub run lookup HTTP "+response.status);
    const data=await response.json();
    Object.assign(row,{createdAt:data.created_at,startedAt:data.run_started_at,head:data.head_sha,url:data.html_url,
      queueMinutes:(Date.parse(data.run_started_at)-Date.parse(data.created_at))/60000});
  }
}catch(err){row.lookupError=String(err.message||err);}
const previous=old.runs.at(-1);
row.intervalMinutes=previous?(Date.parse(row.observedAt)-Date.parse(previous.observedAt))/60000:null;
writeJson(file,{note:"Created/start times identify runner queueing, not the scheduler's intended trigger time. A successful run does not imply punctual scheduling.",runs:[...old.runs.filter(r=>r.id!==row.id),row].slice(-288)});
console.log(JSON.stringify(row,null,2));
