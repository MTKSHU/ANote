// Both remote and local MCP use the same schema, validation and block edits.
import * as model from '@anote/sync-core/mcp-model';
import {fail} from './errors.js';
export {noteHash,changeDiff,editorRules,MCP_TOOLSET_VERSION} from '@anote/sync-core/mcp-model';
function translate<T>(work:()=>T):T {try{return work();}catch(error){if(error instanceof model.McpModelError)fail(error.status,error.message);throw error;}}
export function validateRichDocument(...args:Parameters<typeof model.validateRichDocument>){return translate(()=>model.validateRichDocument(...args));}
export function validateEditorDocument(...args:Parameters<typeof model.validateEditorDocument>){return translate(()=>model.validateEditorDocument(...args));}
export function editBlocks(...args:Parameters<typeof model.editBlocks>){return translate(()=>model.editBlocks(...args));}
