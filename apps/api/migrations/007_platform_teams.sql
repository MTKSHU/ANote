ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE auth_identities ADD COLUMN validated_configuration TEXT;
CREATE UNIQUE INDEX users_verified_email_idx ON users(lower(email)) WHERE email IS NOT NULL AND email_verified;
CREATE TABLE platform_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 site_name TEXT NOT NULL DEFAULT 'ANote',
 public_origin TEXT NOT NULL DEFAULT '',
 allowed_origins TEXT[] NOT NULL DEFAULT '{}',
 auth_mode TEXT NOT NULL DEFAULT 'both' CHECK(auth_mode IN ('local','oidc','both')),
 oidc_issuer TEXT NOT NULL DEFAULT '',
 oidc_client_id TEXT NOT NULL DEFAULT '',
 oidc_secret TEXT NOT NULL DEFAULT '',
 oidc_application TEXT NOT NULL DEFAULT '',
 revision BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE teams (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 allow_external_sharing BOOLEAN NOT NULL DEFAULT false,
 members_can_create_libraries BOOLEAN NOT NULL DEFAULT true,
 announcement_doc_id TEXT REFERENCES documents(id), archived BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE team_members (
 team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('admin','member')),joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,user_id)
);
CREATE TABLE team_invites (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), token_hash TEXT NOT NULL UNIQUE,
 email TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, accepted_by TEXT REFERENCES users(id)
);
ALTER TABLE spaces ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE spaces ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'restricted' CHECK(access_mode IN ('team','restricted'));
ALTER TABLE spaces ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
INSERT INTO teams(id,name,description,created_by,allow_external_sharing)
 SELECT 'team-initial',p.name,p.description,u.id,true FROM team_profile p
 CROSS JOIN LATERAL (SELECT id FROM users WHERE active AND is_admin ORDER BY created_at LIMIT 1) u;
UPDATE spaces SET team_id='team-initial' WHERE kind='team' AND EXISTS(SELECT 1 FROM teams WHERE id='team-initial');
INSERT INTO team_members(team_id,user_id,role)
 SELECT 'team-initial',u.id,CASE WHEN u.is_admin THEN 'admin' ELSE 'member' END FROM users u
 WHERE EXISTS(SELECT 1 FROM teams WHERE id='team-initial') AND
 (u.is_admin OR EXISTS(SELECT 1 FROM space_members m JOIN spaces s ON s.id=m.space_id WHERE m.user_id=u.id AND s.kind='team'));
-- Preserve the previous private boundary, stable note IDs, Yjs state, comments and links.
INSERT INTO spaces(id,name,description,created_by,kind,access_mode)
 SELECT 'personal-migrated-'||u.id,'迁移的私人笔记','从旧团队知识库保留的私人笔记',u.id,'personal','restricted'
 FROM users u WHERE EXISTS(SELECT 1 FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.created_by=u.id AND d.visibility='private' AND s.kind='team');
INSERT INTO space_members(space_id,user_id,role)
 SELECT id,created_by,'admin' FROM spaces WHERE id LIKE 'personal-migrated-%';
INSERT INTO folders(id,space_id,name)
 SELECT DISTINCT 'migrated-root-'||md5(d.created_by||':'||s.id),'personal-migrated-'||d.created_by,s.name
 FROM documents d JOIN spaces s ON s.id=d.space_id WHERE s.kind='team' AND d.visibility='private';
INSERT INTO folders(id,space_id,parent_id,name,position)
 SELECT DISTINCT 'migrated-folder-'||md5(d.created_by||':'||f.id),'personal-migrated-'||d.created_by,
 CASE WHEN f.parent_id IS NULL THEN 'migrated-root-'||md5(d.created_by||':'||s.id) ELSE 'migrated-folder-'||md5(d.created_by||':'||f.parent_id) END,f.name,f.position
 FROM documents d JOIN spaces s ON s.id=d.space_id JOIN folders f ON f.space_id=s.id WHERE s.kind='team' AND d.visibility='private';
INSERT INTO audit_events(actor,action,target,detail)
 SELECT d.created_by,'migration.private-note',d.id,json_build_object('old_space',d.space_id,'new_space','personal-migrated-'||d.created_by)
 FROM documents d JOIN spaces s ON s.id=d.space_id WHERE d.visibility='private' AND s.kind='team';
UPDATE documents d SET space_id='personal-migrated-'||d.created_by,
 folder_id=CASE WHEN d.folder_id IS NULL THEN 'migrated-root-'||md5(d.created_by||':'||s.id) ELSE 'migrated-folder-'||md5(d.created_by||':'||d.folder_id) END,access_revision=access_revision+1
 FROM spaces s WHERE s.id=d.space_id AND s.kind='team' AND d.visibility='private';
UPDATE assets a SET space_id=d.space_id FROM documents d WHERE a.owner_doc_id=d.id AND d.space_id LIKE 'personal-migrated-%';
UPDATE upload_sessions a SET space_id=d.space_id FROM documents d WHERE a.doc_id=d.id AND d.space_id LIKE 'personal-migrated-%';
CREATE INDEX spaces_team_idx ON spaces(team_id);
CREATE INDEX team_members_user_idx ON team_members(user_id);

CREATE FUNCTION effective_space_role(actor TEXT,library TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN s.created_by=actor THEN 'admin' END
 WHEN t.archived OR tm.user_id IS NULL THEN NULL
 WHEN tm.role='admin' THEN 'admin'
 WHEN m.role IS NOT NULL THEN m.role
 WHEN s.access_mode='team' THEN 'editor' END
 FROM spaces s JOIN users u ON u.id=actor AND u.active
 LEFT JOIN teams t ON t.id=s.team_id
 LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=actor
 LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=actor WHERE s.id=library
$$;
CREATE FUNCTION effective_document_role(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
 WHEN effective_space_role(actor,s.id) IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='admin' THEN 'admin'
 WHEN d.visibility='private' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
 WHEN effective_space_role(actor,s.id)='viewer' THEN 'viewer'
 WHEN effective_space_role(actor,s.id)='reviewer' THEN CASE WHEN c.role='viewer' THEN 'viewer' ELSE 'reviewer' END
 WHEN d.created_by=actor THEN 'admin' ELSE COALESCE(c.role,effective_space_role(actor,s.id)) END
 FROM documents d JOIN spaces s ON s.id=d.space_id JOIN users u ON u.id=actor AND u.active
 LEFT JOIN document_collaborators c ON c.doc_id=d.id AND c.user_id=actor WHERE d.id=note
$$;
