import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate, transaction } from './db.js';
import { hashPassword, verifyPassword, setSession, clearSession, currentUser } from './auth.js';
import { getSettings, getPartnerUsers, rebuildProfitLedger, getPartnerBalance, getPartnerLedger, getPartnerSummary, getReport, getDashboard, getTransactions, validateWithdrawal } from './accounting.js';

migrate();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(__dirname,'../public');
const port=Number(process.env.PORT||3000);
const round2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const now=()=>new Date().toISOString();
const actionNames={create:'إضافة',update:'تعديل',delete:'حذف'};

function audit(userId,action,entityType,entityId,oldValue,newValue){db.prepare(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,old_value,new_value) VALUES (?,?,?,?,?,?)`).run(userId||null,action,entityType,entityId||null,oldValue==null?null:JSON.stringify(oldValue),newValue==null?null:JSON.stringify(newValue))}
function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)});res.end(body)}
async function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1_000_000) reject(new Error('الطلب كبير جدًا.'))});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(new Error('بيانات JSON غير صالحة.'))}});req.on('error',reject)})}
function requireUser(req,res){const u=currentUser(req);if(!u){json(res,401,{error:'غير مصرح.'});return null}return u}
function requireAdmin(req,res){const u=requireUser(req);if(!u)return null;if(u.role!=='admin'){json(res,403,{error:'هذا الإجراء متاح للمدير فقط.'});return null}return u}
function date(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')))throw new Error('التاريخ يجب أن يكون بصيغة YYYY-MM-DD');return v}
function pos(v){const x=Number(v);if(!Number.isFinite(x)||x<=0)throw new Error('المبلغ يجب أن يكون أكبر من صفر.');return round2(x)}
function pct(v){const x=Number(v);if(!Number.isFinite(x)||x<0||x>100)throw new Error('النسبة غير صالحة.');return round2(x)}
function sendFile(res,file){fs.readFile(file,(err,b)=>{if(err){json(res,404,{error:'الصفحة غير موجودة.'});return}const ext=path.extname(file);const ct=ext==='.html'?'text/html; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'application/javascript; charset=utf-8';res.writeHead(200,{'Content-Type':ct,'Cache-Control':'no-store'});res.end(b)})}

async function handle(req,res){
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);const p=u.pathname;const method=req.method;
  try{
    if(method==='POST'&&p==='/api/login'){
      const b=await body(req);const user=db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username||'').trim());
      if(!user||!user.is_active||!verifyPassword(String(b.password||''),user.password_hash))return json(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة.'});
      setSession(res,user);return json(res,200,{user:{id:user.id,username:user.username,display_name:user.display_name,role:user.role,partner_key:user.partner_key}})
    }
    if(method==='POST'&&p==='/api/logout'){clearSession(res);return json(res,200,{ok:true})}
    if(method==='GET'&&p==='/api/me'){const user=requireUser(req,res);if(!user)return;return json(res,200,{user})}

    if(p.startsWith('/api/')){
      const user=requireUser(req,res); if(!user)return;
      if(method==='GET'&&p==='/api/dashboard'){const d=getDashboard();if(user.role==='partner'){const own=d.partners.find(x=>x.id===user.id);return json(res,200,{...d,partners:own?[own]:[]})}return json(res,200,d)}
      if(method==='GET'&&p==='/api/settings'){const s=getSettings();return json(res,200,{...s,share_total:round2(s.azam_share_pct+s.waseem_share_pct),distribution_consistency:round2(s.project_retention_pct+s.distribution_pct)})}
      if(method==='GET'&&p==='/api/partners'){if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});return json(res,200,getPartnerUsers().map(x=>({id:x.id,name:x.display_name,key:x.partner_key})))}
      if(method==='GET'&&p==='/api/transactions'){
        const partnerId=user.role==='partner'?user.id:(u.searchParams.get('partnerId')?Number(u.searchParams.get('partnerId')):undefined);
        return json(res,200,getTransactions({type:u.searchParams.get('type')||undefined,category:u.searchParams.get('category')||undefined,partnerId,start:u.searchParams.get('start')||undefined,end:u.searchParams.get('end')||undefined}))
      }
      if(method==='GET'&&p==='/api/partner/me'){
        const partnerId=user.role==='partner'?user.id:Number(u.searchParams.get('partnerId')||user.id);if(user.role==='partner'&&partnerId!==user.id)return json(res,403,{error:'غير مصرح.'});
        const summary=getPartnerSummary(partnerId);if(!summary)return json(res,404,{error:'الشريك غير موجود.'});
        const ledger=getPartnerLedger(partnerId);const profitRows=db.prepare(`SELECT pp.start_date,pp.end_date,pp.net_profit,pa.share_pct,pa.allocated_amount FROM profit_allocations pa JOIN profit_periods pp ON pp.id=pa.profit_period_id WHERE pa.partner_id=? ORDER BY pp.start_date DESC`).all(partnerId);const withdrawals=getTransactions({type:'withdrawal',partnerId});return json(res,200,{summary,ledger,profitRows,withdrawals})
      }
      if(method==='GET'&&p==='/api/report'){
        const type=['weekly','monthly','custom'].includes(u.searchParams.get('type'))?u.searchParams.get('type'):'weekly';const start=u.searchParams.get('start')||new Date().toISOString().slice(0,10);const end=u.searchParams.get('end')||start;const r=getReport(type,start,end);if(user.role==='partner')r.partners=r.partners.filter(x=>x.id===user.id);return json(res,200,r)
      }
      if(method==='GET'&&p==='/api/audit'){if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});return json(res,200,db.prepare(`SELECT a.*,u.display_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500`).all())}
      if(method==='GET'&&p==='/api/users'){if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});return json(res,200,db.prepare(`SELECT id,username,display_name,role,partner_key,is_active,created_at FROM users ORDER BY id`).all())}
      if(method==='POST'&&p==='/api/income'){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});const b=await body(req);const id=transaction(()=>db.prepare(`INSERT INTO transactions(occurred_on,amount,type,category,partner_id,note,reference,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(date(b.occurred_on),pos(b.amount),'income',String(b.category||'operating_income'),null,b.note||null,b.reference||null,user.id).lastInsertRowid);audit(user.id,'create','transaction',id,null,b);rebuildProfitLedger();return json(res,201,{id})
      }
      if(method==='POST'&&p==='/api/expense'){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});const b=await body(req);const cats=['advertising','transfer','transfer_fee','other'];if(!cats.includes(b.category))return json(res,400,{error:'تصنيف المصروف غير صالح.'});const id=transaction(()=>db.prepare(`INSERT INTO transactions(occurred_on,amount,type,category,partner_id,note,reference,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(date(b.occurred_on),pos(b.amount),'expense',b.category,null,b.note||null,b.reference||null,user.id).lastInsertRowid);audit(user.id,'create','transaction',id,null,b);rebuildProfitLedger();return json(res,201,{id})
      }
      if(method==='POST'&&p==='/api/withdrawals'){
        const b=await body(req);const partnerId=user.role==='admin'?Number(b.partner_id):user.id;const amount=pos(b.amount),occurredOn=date(b.occurred_on);const valid=validateWithdrawal(partnerId,amount,occurredOn);if(!valid.ok)return json(res,400,{error:valid.reason});const cats=['personal','profit','other'];if(!cats.includes(b.category))return json(res,400,{error:'نوع السحب غير صالح.'});const id=transaction(()=>db.prepare(`INSERT INTO transactions(occurred_on,amount,type,category,partner_id,note,reference,created_by) VALUES (?,?,?,?,?,?,?,?)`).run(occurredOn,amount,'withdrawal',b.category,partnerId,b.note||null,b.reference||null,user.id).lastInsertRowid);audit(user.id,'create','withdrawal',id,null,b);rebuildProfitLedger();return json(res,201,{id,balance:getPartnerBalance(partnerId)})
      }
      if(method==='PUT'&&p.startsWith('/api/transactions/')){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});
        const id=Number(p.split('/').pop());const old=db.prepare('SELECT * FROM transactions WHERE id=? AND deleted_at IS NULL').get(id);if(!old)return json(res,404,{error:'العملية غير موجودة.'});
        const b=await body(req); const type=b.type||old.type;
        if(old.type==='withdrawal'){
          const partnerId=old.partner_id; const occurredOn=date(b.occurred_on||old.occurred_on); const amount=pos(b.amount??old.amount);
          const valid=validateWithdrawal(partnerId,amount,occurredOn,id); if(!valid.ok)return json(res,400,{error:valid.reason});
          const cat=['personal','profit','other'].includes(b.category)?b.category:old.category;
          const updated={...old,occurred_on:occurredOn,amount,type:'withdrawal',category:cat,note:b.note??null,reference:b.reference??null,updated_at:now()};
          transaction(()=>db.prepare(`UPDATE transactions SET occurred_on=?,amount=?,category=?,note=?,reference=?,updated_at=? WHERE id=?`).run(updated.occurred_on,updated.amount,updated.category,updated.note,updated.reference,updated.updated_at,id));
          audit(user.id,'update','withdrawal',id,old,updated);rebuildProfitLedger();return json(res,200,{ok:true,balance:getPartnerBalance(partnerId)});
        }
        if(type==='withdrawal')return json(res,400,{error:'تغيير نوع الدخل/المصروف إلى سحب غير مسموح؛ أنشئ سحبًا مستقلًا.'});
        const cat=type==='expense'?b.category:(b.category||old.category);if(type==='expense'&&!['advertising','transfer','transfer_fee','other'].includes(cat))return json(res,400,{error:'تصنيف المصروف غير صالح.'});
        const updated={...old,occurred_on:date(b.occurred_on||old.occurred_on),amount:pos(b.amount??old.amount),type,category:cat,note:b.note??null,reference:b.reference??null,updated_at:now()};
        transaction(()=>db.prepare(`UPDATE transactions SET occurred_on=?,amount=?,type=?,category=?,note=?,reference=?,updated_at=? WHERE id=?`).run(updated.occurred_on,updated.amount,updated.type,updated.category,updated.note,updated.reference,updated.updated_at,id));audit(user.id,'update','transaction',id,old,updated);rebuildProfitLedger();return json(res,200,{ok:true})
      }
      if(method==='DELETE'&&p.startsWith('/api/transactions/')){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});const id=Number(p.split('/').pop());const old=db.prepare('SELECT * FROM transactions WHERE id=? AND deleted_at IS NULL').get(id);if(!old)return json(res,404,{error:'العملية غير موجودة.'});transaction(()=>db.prepare('UPDATE transactions SET deleted_at=?,deleted_by=? WHERE id=?').run(now(),user.id,id));audit(user.id,'delete','transaction',id,old,null);rebuildProfitLedger();return json(res,200,{ok:true})
      }
      if(method==='PUT'&&p==='/api/settings'){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});const b=await body(req);const old=getSettings();const azam=pct(b.azam_share_pct),waseem=pct(b.waseem_share_pct),ret=pct(b.project_retention_pct),dist=pct(b.distribution_pct),min=pct(b.withdrawal_min_pct),max=pct(b.withdrawal_max_pct);if(Math.abs(azam+waseem-100)>0.001)return json(res,400,{error:'نسب الشراكة يجب أن يكون مجموعها 100%.'});if(Math.abs(ret+dist-100)>0.001)return json(res,400,{error:'نسبة الاحتفاظ + التوزيع يجب أن تساوي 100%.'});if(min>max)return json(res,400,{error:'الحد الأدنى للسحب لا يمكن أن يتجاوز الحد الأقصى.'});const limit=['weekly','monthly'].includes(b.withdrawal_limit_period)?b.withdrawal_limit_period:old.withdrawal_limit_period;const week=Number(b.accounting_week_start),month=Number(b.accounting_month_start);if(week<0||week>6||!Number.isInteger(week))return json(res,400,{error:'بداية الأسبوع غير صالحة.'});if(month<1||month>28||!Number.isInteger(month))return json(res,400,{error:'بداية الشهر يجب أن تكون بين 1 و28.'});const visible=b.partners_can_view_each_other?1:0;transaction(()=>{db.prepare(`UPDATE settings SET azam_share_pct=?,waseem_share_pct=?,project_retention_pct=?,distribution_pct=?,withdrawal_min_pct=?,withdrawal_max_pct=?,withdrawal_limit_period=?,accounting_week_start=?,accounting_month_start=?,partners_can_view_each_other=?,updated_at=?,updated_by=? WHERE id=1`).run(azam,waseem,ret,dist,min,max,limit,week,month,visible,now(),user.id);db.prepare(`INSERT INTO settings_history(effective_on,azam_share_pct,waseem_share_pct,project_retention_pct,distribution_pct,withdrawal_min_pct,withdrawal_max_pct,withdrawal_limit_period,accounting_week_start,accounting_month_start,partners_can_view_each_other,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(now().slice(0,10),azam,waseem,ret,dist,min,max,limit,week,month,visible,user.id);});audit(user.id,'update','settings',1,old,getSettings());rebuildProfitLedger();return json(res,200,getSettings())
      }
      if(method==='POST'&&p==='/api/users'){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});const b=await body(req);if(!b.username||!b.password||!b.display_name||!['admin','partner'].includes(b.role))return json(res,400,{error:'بيانات المستخدم غير مكتملة.'});if(b.role==='partner'&&!['azam','waseem'].includes(b.partner_key))return json(res,400,{error:'الشريك يجب أن يكون azam أو waseem.'});const id=transaction(()=>db.prepare(`INSERT INTO users(username,display_name,role,password_hash,partner_key) VALUES (?,?,?,?,?)`).run(String(b.username).trim(),String(b.display_name).trim(),b.role,hashPassword(b.password),b.role==='partner'?b.partner_key:null).lastInsertRowid);audit(user.id,'create','user',id,null,{username:b.username,display_name:b.display_name,role:b.role,partner_key:b.partner_key});return json(res,201,{id})
      }
      if(method==='PATCH'&&p.startsWith('/api/users/')){
        if(user.role!=='admin')return json(res,403,{error:'للمدير فقط.'});const id=Number(p.split('/').pop());const old=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!old)return json(res,404,{error:'المستخدم غير موجود.'});const b=await body(req);const name=b.display_name??old.display_name;const active=b.is_active==null?old.is_active:(b.is_active?1:0);let passwordHash=old.password_hash;if(b.password)passwordHash=hashPassword(b.password);const updated={display_name:name,is_active:active,password_changed:Boolean(b.password)};transaction(()=>db.prepare('UPDATE users SET display_name=?,is_active=?,password_hash=? WHERE id=?').run(name,active,passwordHash,id));audit(user.id,'update','user',id,{display_name:old.display_name,is_active:old.is_active,password_changed:false},updated);return json(res,200,{ok:true})
      }
      return json(res,404,{error:'API endpoint not found.'});
    }
    let file=p==='/'?path.join(publicDir,'index.html'):path.join(publicDir,p.replace(/^\//,''));if(!file.startsWith(publicDir))return json(res,403,{error:'Forbidden'});if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(publicDir,'index.html');return sendFile(res,file);
  }catch(e){console.error(e);return json(res,400,{error:e.message||'حدث خطأ.'})}
}
http.createServer((req,res)=>handle(req,res)).listen(port,()=>console.log(`Partner Ledger: http://localhost:${port}`));
