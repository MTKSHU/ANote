import {encrypt,decrypt,platformConfig} from "./platform.js";
import {digest} from "./database.js";
import {fail} from "./errors.js";
export const sealShareToken=(token:string)=>encrypt(token);
export const defaultWatermark=(name:string)=>name+" · "+platformConfig().site_name;
export function watermarkSettings(input:any,name:string,existing?:any) {
  const enabled=input?.watermark_enabled??existing?.watermark_enabled??true;
  const value=input?.watermark_text??existing?.watermark_text??"";
  if(typeof enabled!=="boolean"||typeof value!=="string"||value.length>160||/[\u0000-\u001f\u007f]/u.test(value))fail(400,"水印设置无效，文本最多 160 字符");
  return {enabled,text:value.trim()||defaultWatermark(name)};
}
export function shareLinkView(row:any,kind:"notes"|"libraries") {
  const {token_encrypted,token_hash,...visible}=row;let path:string|null=null;
  if(token_encrypted)try{const token=decrypt(token_encrypted);if(/^[\w-]{43}$/.test(token)&&digest(token)===token_hash)path=(kind==="libraries"?"/share/library/":"/share/")+token;}catch{}
  return {...visible,path,url:path&&platformConfig().public_origin?platformConfig().public_origin+path:null,watermark_default:defaultWatermark(row.shared_by||"")};
}
export const publicWatermark=(row:any)=>row.watermark_enabled?{text:row.watermark_text||defaultWatermark(row.shared_by||"")}:null;
