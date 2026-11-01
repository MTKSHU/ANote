import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Req,
  Res,
  Module,
  Inject,
  Query,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, migrate } from "./database.js";
import {
  bootstrap,
  login,
  logout,
  user,
  administrator,
  createUser,
  publicUser,
  spaceRole,
  requestToken,
  changeOwnPassword,
} from "./auth.js";
import * as workspace from "./workspaces.js";
import * as libraryCatalog from "./catalog.js";
import * as teams from "./team.js";
import {
  PlatformController,
  initializePlatform,
  platformConfig,
} from "./platform.js";
import { TeamsController } from "./teams.js";
import { TrashController } from "./trash.js";
import { startTrashMaintenance } from "./trash-maintenance.js";
import { CasdoorController } from "./casdoor.js";
import { identifier, fail, text } from "./errors.js";
import { SharingController } from "./sharing.js";
import { Documents } from "./documents.js";
import { AssetsModule } from "./assets.js";
import { RecordsModule } from "./records.js";
import { ReleasesModule } from "./releases.js";
import { requestSecurity } from "./request-security.js";
import { initializeStorage } from "./storage.js";
import { McpConnectionsController } from "./mcp-auth.js";
import { installMcp } from "./mcp.js";
import { initializeOnboarding, onboardingOnVisit } from "./onboarding.js";

@Controller("api")
class ControllerAPI {
  constructor(@Inject(Documents) private readonly documents: Documents) {}
  @Get("spaces/:id/catalog") async catalog(@Req() req: Request, @Param("id") id: string) {
    return libraryCatalog.catalog(await user(req), identifier(id));
  }
  @Patch("spaces/:id/catalog") async reorder(@Req() req: Request, @Param("id") id: string, @Body() input: any) {
    return libraryCatalog.reorder(await user(req), identifier(id), input);
  }
  @Get("health") health() {
    return { ok: true, mode: "workspace", version: "0.1.0" };
  }
  @Post("auth/login") login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() input: any,
  ) {
    return login(req, res, input);
  }
  @Post("auth/logout") logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return logout(req, res);
  }
  @Get("auth/session") async session(@Req() req: Request) {
    const account=await user(req);
    await onboardingOnVisit(account.id);
    return { user: account, token: requestToken(req) };
  }
  @Get("me") me(@Req() req: Request) {
    return user(req);
  }
  @Patch("me/profile") async nickname(@Req() req: Request, @Body() input: any) {
    const account = await user(req);
    const name = text(input?.name, "昵称", 80);
    if (/[\u0000-\u001f\u007f]/u.test(name)) fail(400, "昵称不能包含换行或控制字符");
    await db.query("UPDATE users SET name=$2 WHERE id=$1", [account.id, name]);
    return { ...account, name };
  }
  @Patch("me/preferences") async preferences(
    @Req() req: Request,
    @Body() input: any,
  ) {
    const account = await user(req);
    if (!["light", "dark", "auto"].includes(input?.theme))
      fail(400, "请选择 Light、Dark 或 Auto 主题");
    await db.query("UPDATE users SET theme=$2 WHERE id=$1", [
      account.id,
      input.theme,
    ]);
    return { theme: input.theme };
  }
  @Patch("me") async profile(@Req() req: Request, @Body() input: any) {
    const account = await user(req);
    const result = await changeOwnPassword(account, input);
    this.documents.disconnectUser(account.id);
    return result;
  }
  @Get("users") async users(@Req() req: Request) {
    administrator(await user(req));
    return (
      await db.query(
        "SELECT id,username,name,is_admin,active FROM users ORDER BY name",
      )
    ).rows;
  }
  @Post("users") async createUser(@Req() req: Request, @Body() input: any) {
    return createUser(await user(req), input);
  }
  @Post("users/:id/revoke-sessions") async revokeSessions(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const account = await user(req);
    administrator(account);
    identifier(id);
    await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    this.documents.disconnectUser(id);
    await db.query(
      "INSERT INTO audit_events(actor,action,target) VALUES($1,'account.sessions.revoke',$2)",
      [account.id, id],
    );
    return { ok: true };
  }
  @Get("team") async team(@Req() req: Request) {
    return teams.team(await user(req));
  }
  @Patch("team") async updateTeam(@Req() req: Request, @Body() input: any) {
    return teams.updateTeam(await user(req), input);
  }
  @Patch("team/members/:id") async updateMember(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    if (await teams.updateMember(await user(req), identifier(id), input))
      this.documents.disconnectUser(id);
    return { ok: true };
  }
  @Get("spaces") async spaces(@Req() req: Request) {
    return workspace.spaces(await user(req));
  }
  @Get("documents") async listDocuments(
    @Req() req: Request,
    @Query("space_id") space?: string,
    @Query("q") search?: string,
    @Query("archived") archived?: string,
  ) {
    return this.documents.list(
      await user(req),
      space,
      search,
      archived === "true",
    );
  }
  @Get("trash/documents") async trashList(@Req() req: Request) {
    return this.documents.trashList(await user(req));
  }
  @Delete("documents/:id") async trash(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.trash(await user(req), identifier(id));
  }
  @Post("documents/:id/restore-deleted") async restoreDeleted(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.restoreDeleted(await user(req), identifier(id));
  }
  @Get("spaces/:id/member-candidates") async memberCandidates(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    await spaceRole(await user(req), identifier(id), "manage");
    return (
      await db.query(
        "SELECT u.id,u.username,u.name FROM users u JOIN team_members m ON m.user_id=u.id JOIN spaces s ON s.team_id=m.team_id WHERE u.active=true AND s.id=$1 ORDER BY u.name",
        [id],
      )
    ).rows;
  }
  @Post("documents") async createDocument(
    @Req() req: Request,
    @Body() input: any,
  ) {
    return this.documents.create(await user(req), input);
  }
  @Get("documents/:id") async getDocument(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.get(await user(req), identifier(id));
  }
  @Patch("documents/:id") async metadata(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return this.documents.metadata(await user(req), identifier(id), input);
  }
  @Post("documents/:id/move-preview") async previewMove(@Req() req:Request,@Param("id") id:string,@Body() input:any){return this.documents.previewMove(await user(req),identifier(id),input);}
  @Post("documents/:id/move") async moveDocument(@Req() req:Request,@Param("id") id:string,@Body() input:any){return this.documents.move(await user(req),identifier(id),input);}
  @Get("documents/:id/export") async exportDocument(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.export(await user(req), identifier(id));
  }
  @Post("documents/:id/import") async importDocument(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
    @Res() res: Response,
  ) {
    const result = await this.documents.import(
      await user(req),
      identifier(id),
      input,
    );
    res.status(result.status).json(result.result);
  }
  @Get("documents/:id/comments") async comments(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.comments(await user(req), identifier(id));
  }
  @Post("documents/:id/comments") async comment(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return this.documents.comment(await user(req), identifier(id), input);
  }
  @Patch("documents/:id/comments/:comment") async resolveComment(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("comment") comment: string,
    @Body() input: any,
  ) {
    return this.documents.resolveComment(
      await user(req),
      identifier(id),
      identifier(comment),
      input?.resolved,
    );
  }
  @Get("documents/:id/reviews") async reviews(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.reviews(await user(req), identifier(id));
  }
  @Post("documents/:id/reviews") async submit(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return this.documents.submit(await user(req), identifier(id), input);
  }
  @Post("documents/:id/reviews/:review/decision") async decide(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("review") review: string,
    @Body() input: any,
  ) {
    return this.documents.decide(
      await user(req),
      identifier(id),
      identifier(review),
      input,
    );
  }
  @Get("documents/:id/versions") async versions(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.versions(await user(req), identifier(id));
  }
  @Post("documents/:id/versions") async checkpoint(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return this.documents.checkpoint(await user(req), identifier(id), input);
  }
  @Post("documents/:id/save") async save(@Req() req: Request, @Param("id") id: string) {
    return this.documents.save(await user(req), identifier(id));
  }
  @Get("documents/:id/versions/:version") async version(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("version") version: string,
  ) {
    return this.documents.version(
      await user(req),
      identifier(id),
      identifier(version),
    );
  }
  @Post("documents/:id/versions/:version/restore") async restore(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("version") version: string,
    @Body() input: any,
  ) {
    return this.documents.restore(
      await user(req),
      identifier(id),
      identifier(version),
      input,
    );
  }
  @Get("documents/:id/conflicts") async conflicts(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return this.documents.conflicts(await user(req), identifier(id));
  }
  @Post("spaces") async createSpace(@Req() req: Request, @Body() input: any) {
    return workspace.createSpace(await user(req), input);
  }
  @Patch("spaces/:id/sidebar-pin") sidebarPin(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return user(req).then((account) =>
      workspace.setSidebarPin(account, identifier(id), input),
    );
  }
  @Patch("spaces/:id") async updateSpace(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const result = await workspace.updateSpace(
      await user(req),
      identifier(id),
      input,
    );
    if (input.access_mode !== undefined) {
      await db.query(
        "UPDATE documents SET access_revision=access_revision+1 WHERE space_id=$1",
        [id],
      );
      for (const note of (
        await db.query("SELECT id FROM documents WHERE space_id=$1", [id])
      ).rows)
        this.documents.disconnect(note.id);
    }
    return result;
  }
  @Get("spaces/:id/members") async members(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return workspace.members(await user(req), identifier(id));
  }
  @Post("spaces/:id/members") async setMember(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    const result = await workspace.setMember(
      await user(req),
      identifier(id),
      input,
    );
    for (const doc of (
      await db.query("SELECT id FROM documents WHERE space_id=$1", [id])
    ).rows)
      this.documents.disconnect(doc.id);
    return result;
  }
  @Get("spaces/:id/folders") async folders(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return workspace.folders(await user(req), identifier(id));
  }
  @Post("spaces/:id/folders") async createFolder(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() input: any,
  ) {
    return workspace.createFolder(await user(req), identifier(id), input);
  }
  @Patch("spaces/:id/folders/:folder") async moveFolder(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("folder") folder: string,
    @Body() input: any,
  ) {
    return workspace.moveFolder(
      await user(req),
      identifier(id),
      identifier(folder),
      input,
    );
  }
  @Delete("spaces/:id/folders/:folder") async removeFolder(@Req() req:Request,@Param("id") id:string,@Param("folder") folder:string) {
    return libraryCatalog.removeFolder(await user(req),identifier(id),identifier(folder));
  }
}
@Module({
  imports: [AssetsModule, RecordsModule, ReleasesModule],
  controllers: [
    ControllerAPI,
    SharingController,
    CasdoorController,
    PlatformController,
    TeamsController,
    TrashController,
    McpConnectionsController,
  ],
  providers: [Documents],
})
class AppModule {}
await migrate();
await initializeStorage();
await initializePlatform();
await bootstrap();
await initializeOnboarding();
const app = await NestFactory.create(AppModule, {
  bodyParser: false,
  logger: ["error", "warn", "log"],
});
app.use(express.json({ limit: "8mb" }));
const stopMcp=installMcp(app.getHttpAdapter().getInstance(),app.get(Documents));
app.use((req: Request, res: Response, next: express.NextFunction) =>
  requestSecurity(
    platformConfig().public_origin,
    platformConfig().allowed_origins,
  )(req, res, next),
);
app.use(
  express.static(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../web/dist",
    ),
  ),
);
app.getHttpAdapter().getInstance().get("/favicon.ico",(_req:Request,res:Response)=>res.redirect(308,"/favicon.svg"));
app.use("/share/:token", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.sendFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../web/dist/index.html",
    ),
  );
});
await app.init();
const documents = app.get(Documents);
await documents.start(app.getHttpAdapter().getInstance());
const stopTrashMaintenance = startTrashMaintenance(documents);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void (async () => {
      const maintenance = stopTrashMaintenance();
      stopMcp();
      await documents.close();
      await maintenance;
      await app.close();
      await db.end();
      process.exit(0);
    })();
  });
