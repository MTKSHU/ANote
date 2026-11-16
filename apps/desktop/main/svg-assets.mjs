import fs from "node:fs/promises";
import {isSvgImagePrefix,SVG_MIME,SVG_HEADER_BYTES} from "@anote/document-model/svg";

/** Virtual compatibility for attachments saved by versions without SVG support. */
export async function normalizeSvgAsset(row,file){
  if(row.mime===SVG_MIME)return {...row,kind:"image"};
  if(row.kind!=="file"||!/\.svg$/i.test(row.filename||""))return row;
  let handle;
  try{
    handle=await fs.open(file,"r");const header=Buffer.alloc(Math.min(SVG_HEADER_BYTES,Number(row.bytes)||SVG_HEADER_BYTES));
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if(isSvgImagePrefix(header.subarray(0,bytesRead).toString("utf8")))return {...row,kind:"image",mime:SVG_MIME};
  }catch{/* Missing originals retain the existing attachment-unavailable behavior. */}
  finally{await handle?.close();}
  return row;
}
