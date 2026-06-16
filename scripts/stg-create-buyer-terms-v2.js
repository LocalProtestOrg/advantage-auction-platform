#!/usr/bin/env node
/* stg-create-buyer-terms-v2.js — STAGING-guarded. Inserts Buyer Terms v2 as a
 * NON-CURRENT draft (is_current=false). v1 remains current. Idempotent. Body is
 * read from public/terms.html (the canonical source). Does NOT activate v2. */
const fs=require('fs'),path=require('path'),{Pool}=require('pg');
(async()=>{const raw=process.env.DATABASE_URL||'';
  if(raw.includes('ep-proud-leaf-an8pzkib')){console.error('REFUSE: wrong endpoint (STAGING-only).');return 2;}
  if(!raw.includes('ep-royal-dawn-anarou3f')){console.error('REFUSE: not the STAGING endpoint.');return 2;}
  const html=fs.readFileSync(path.join(__dirname,'..','public','terms.html'),'utf8');
  const m=html.match(/<script type="text\/plain" id="doc-md">([\s\S]*?)<\/script>/);
  if(!m){console.error('FAIL: could not extract Terms markdown from terms.html');return 1;}
  const body=m[1].trim();
  const title='Advantage.Bid Terms of Service — General and Buyers';
  const pool=new Pool({connectionString:raw.replace('-pooler',''),ssl:{rejectUnauthorized:false}});const c=await pool.connect();
  try{
    const exists=(await c.query("SELECT id,is_current FROM terms_versions WHERE kind='buyer_terms' AND version_int=2")).rows[0];
    if(exists){console.log('SKIP: buyer_terms v2 already exists (is_current='+exists.is_current+'). Not modified.');}
    else{
      await c.query(
        "INSERT INTO terms_versions (kind,version_int,title,body_markdown,effective_at,is_current,created_by) VALUES ('buyer_terms',2,$1,$2,now(),false,NULL)",
        [title, body]);
      console.log('INSERTED buyer_terms v2 (is_current=false, '+body.length+' chars).');
    }
    const cur=(await c.query("SELECT version_int FROM terms_versions WHERE kind='buyer_terms' AND is_current=true")).rows;
    const v2=(await c.query("SELECT is_current FROM terms_versions WHERE kind='buyer_terms' AND version_int=2")).rows[0];
    const pass = cur.length===1 && Number(cur[0].version_int)===1 && v2 && v2.is_current===false;
    console.log('POST current buyer_terms version(s): ['+cur.map(r=>r.version_int).join(',')+'] | v2.is_current='+(v2?v2.is_current:'missing'));
    console.log('RESULT: '+(pass?'PASS (v1 current, v2 draft non-current)':'FAIL'));
    return pass?0:1;
  }catch(e){console.error('FATAL',e.message);return 1;}finally{c.release();await pool.end();}
})().then(c=>process.exit(c||0)).catch(e=>{console.error('FATAL',e.message);process.exit(1);});
