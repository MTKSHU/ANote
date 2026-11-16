import type {User} from "./auth.js";
import {fail,identifier} from "./errors.js";
import {teamRole} from "./teams.js";

/** Omitted scope preserves existing API clients; browser requests always specify it. */
export async function shareScope(account:User,value:unknown):Promise<string|null> {
  if(value===undefined)return null;
  if(typeof value!=="string"||!value)fail(400,"分享空间无效");
  if(value==="personal")return value;
  await teamRole(account,identifier(value),false,true);
  return value;
}
