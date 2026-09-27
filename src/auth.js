import crypto from 'node:crypto';
import { db } from './db.js';

const secret = process.env.JWT_SECRET || 'dev-only-change-me';
const cookieName = 'partner_ledger_session';
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = b => Buffer.from(b,'base64url').toString();

export function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password,stored){
  const [salt,expected]=String(stored||'').split(':');
  if(!salt||!expected) return false;
  const actual=crypto.scryptSync(String(password),salt,64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}
function sign(payload){
  const body=b64u(JSON.stringify({...payload,exp:Date.now()+8*60*60*1000}));
  const sig=crypto.createHmac('sha256',secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token){
  const [body,sig]=String(token||'').split('.'); if(!body||!sig) throw new Error('bad token');
  const expected=crypto.createHmac('sha256',secret).update(body).digest('base64url');
  if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) throw new Error('bad token');
  const p=JSON.parse(unb64u(body)); if(Number(p.exp)<Date.now()) throw new Error('expired'); return p;
}
export function setSession(res,user){
  res.setHeader('Set-Cookie',`${cookieName}=${sign({id:user.id,role:user.role})}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV==='production'?'; Secure':''}`);
}
export function clearSession(res){res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)}
function parseCookies(header=''){return Object.fromEntries(header.split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [i<0?x:x.slice(0,i),i<0?'':decodeURIComponent(x.slice(i+1))]}))}
export function currentUser(req){
  try{const token=parseCookies(req.headers.cookie||'')[cookieName];if(!token) return null;const p=verify(token);const user=db.prepare('SELECT id,username,display_name,role,partner_key,is_active FROM users WHERE id=?').get(p.id);return user&&user.is_active?user:null;}catch{return null;}
}
