#!/usr/bin/env node
/* stg-migrate-069.js — STAGING-guarded apply of ONLY 069_buyer_premium_billing_terms.sql.
 * Additive + idempotent. Verifies new columns + ledger. */
const fs=require('fs'),path=require('path'),{Pool}=require('pg');
const FILE='069_buyer_premium_billing_terms.sql';const FP=path.join(__dirname,'..','db','migrations',FILE);
(async()=>{const raw=process.env.DATABASE_URL||'';
  if(raw.includes('ep-proud-leaf-an8pzkib')){console.error('REFUSE: wrong endpoint (STAGING-only).');return 2;}
  if(!raw.includes('ep-royal-dawn-anarou3f')){console.error('REFUSE: not the STAGING endpoint.');return 2;}
  if(!fs.existsSync(FP)){console.error('FAIL: file missing');return 1;}
  const pool=new Pool({connectionString:raw.replace('-pooler',''),ssl:{rejectUnauthorized:false}});const c=await pool.connect();
  try{
    const before=(await c.query("SELECT 1 FROM schema_migrations WHERE filename=$1",[FILE])).rowCount>0;
    console.log('PRE ledger[069]:',before?'recorded':'not recorded');
    if(before)console.log('SKIP apply (idempotent).');
    else{const sql=fs.readFileSync(FP,'utf8');await c.query('BEGIN');
      try{await c.query(sql);await c.query("INSERT INTO schema_migrations (filename) VALUES ($1)",[FILE]);await c.query('COMMIT');console.log('APPLIED 069 (+ledger).');}
      catch(e){await c.query('ROLLBACK').catch(()=>{});console.error('FAIL apply:',e.message);return 1;}}
    const st=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='seller_terms' AND column_name IN ('aac_bp_share_pct','aac_hammer_commission_pct')")).rows.map(r=>r.column_name);
    const au=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='auctions' AND column_name IN ('aac_bp_share_bps','aac_hammer_commission_bps')")).rows.map(r=>r.column_name);
    const sp=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='seller_payouts' AND column_name IN ('buyer_premium_cents','aac_bp_share_cents','seller_bp_share_cents','aac_hammer_commission_cents','terms_snapshot')")).rows.map(r=>r.column_name);
    const pass=st.length===2&&au.length===2&&sp.length===5;
    console.log('POST seller_terms:'+st.length+'/2 auctions:'+au.length+'/2 seller_payouts:'+sp.length+'/5');
    console.log('RESULT:',pass?'PASS':'FAIL');return pass?0:1;
  }catch(e){console.error('FATAL',e.message);return 1;}finally{c.release();await pool.end();}
})().then(c=>process.exit(c||0)).catch(e=>{console.error('FATAL',e.message);process.exit(1);});
