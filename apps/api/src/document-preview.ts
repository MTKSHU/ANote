import {Controller,Get,Param,Req} from '@nestjs/common';
import type {Request} from 'express';
import {db,digest} from './database.js';
import {stable} from '@anote/sync-core';
import {user,documentRole} from './auth.js';
import {identifier,fail} from './errors.js';

@Controller('api')
export class DocumentPreviewController{
  @Get('documents/:id/preview') async preview(@Req() req:Request,@Param('id') input:string){
    const id=identifier(input),account=await user(req);await documentRole(account,id);
    // Only committed materialized content. This deliberately never opens a
    // Hocuspocus/Y.Doc session or selects its potentially huge state column.
    const row=(await db.query(`SELECT d.id,d.space_id,d.folder_id,d.title,d.tags,d.revision,d.archived,d.updated_at,
      d.visibility,d.created_by,d.access_revision,d.state_encoding,d.state_revision,d.snapshot,
      s.name AS space_name,s.kind AS space_kind,s.archived AS library_archived,s.archive_revision AS library_archive_revision,effective_document_role($2,d.id) AS role
      FROM documents d JOIN spaces s ON s.id=d.space_id
      WHERE d.id=$1 AND d.deleted_at IS NULL AND effective_document_role($2,d.id) IS NOT NULL`,[id,account.id])).rows[0];
    if(!row)fail(403,'笔记不存在或访问权限已变化');
    return {...row,can_manage:row.role==='admin',hash:digest(stable(row.snapshot)),preview_source:'server',snapshot_revision:row.revision};
  }
}
