import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState } from "react";
import { request as api } from "./native";
import { useDialog, DialogClose } from "./dialog";
export function Members({
  session,
  space,
  onError,
}: {
  session: { user: any };
  space: { id: string; name: string; role: string; access_mode?: string };
  onError: (error: unknown) => void;
}) {
  const [members, setMembers] = useState<any[]>([]),
    [users, setUsers] = useState<any[]>([]),
    [selected, setSelected] = useState(""),
    [role, setRole] = useState("viewer");
  async function refresh() {
    try {
      setMembers(await api(`spaces/${space.id}/members`));
      setUsers(await api(`spaces/${space.id}/member-candidates`));
    } catch (error) {
      onError(error);
    }
  }
  useEffect(() => {
    void refresh();
  }, [space.id]);
  const roles = {
    admin: translateUI("管理员"),
    editor: translateUI("编辑全库笔记"),
    reviewer: translateUI("评论者"),
    viewer: translateUI("阅读"),
  };
  return (
    <section className="members-page">
      <div className="home-heading">
        <div>
          <h3>{space.name}</h3>
          <p>{space.access_mode === "restricted" ? translateUI("此知识库仅指定成员与团队管理员可访问。") : translateUI("团队成员默认可阅读、评论并创建自己的笔记。")}{translateUI("授予“编辑全库笔记”后，可修改该库内其他成员的团队可见笔记；目录结构和删除知识库由管理员管理。")}</p>
        </div>
      </div>
      <form
        className="member-add"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await api(`spaces/${space.id}/members`, "POST", {
              user_id: selected,
              role,
            });
            setSelected("");
            await refresh();
          } catch (error) {
            onError(error);
          }
        }}
      >
        <select
          aria-label={translateUI("添加成员")}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          required
        >
          <option value="">{translateUI("选择团队成员")}</option>
          {users
            .filter((user) => !members.some((member) => member.id === user.id))
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.username}
              </option>
            ))}
        </select>
        <select
          aria-label={translateUI("成员角色")}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          {Object.entries(roles).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!selected}>{translateUI("添加到知识库 ")}</button>
      </form>
      <table className="member-table">
        <thead>
          <tr>
            <th>{translateUI("成员")}</th>
            <th>{translateUI("用户名")}</th>
            <th>{translateUI("知识库角色")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id}>
              <td>{member.name}</td>
              <td>{member.username}</td>
              <td>
                <select
                  aria-label={translateUI("角色 {0}", [member.username])}
                  value={member.role}
                  disabled={
                    member.id === session.user.id ||
                    member.team_role === "admin"
                  }
                  onChange={async (event) => {
                    try {
                      await api(`spaces/${space.id}/members`, "POST", {
                        user_id: member.id,
                        role: event.target.value,
                      });
                      await refresh();
                    } catch (error) {
                      onError(error);
                    }
                  }}
                >
                  {member.role === "contributor" && <option value="contributor" disabled>{translateUI("团队默认：评论与新建笔记")}</option>}
                  {Object.entries(roles).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button
                  disabled={
                    member.id === session.user.id ||
                    member.team_role === "admin" ||
                    member.inherited
                  }
                  onClick={async () => {
                    try {
                      await api(`spaces/${space.id}/members`, "POST", {
                        user_id: member.id,
                        role: null,
                      });
                      await refresh();
                    } catch (error) {
                      onError(error);
                    }
                  }}
                >
                  {space.access_mode === "team"
                    ? translateUI("恢复团队默认权限")
                    : translateUI("移出知识库")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

    </section>
  );
}

export function LibraryPermissionsDialog({user,space,onClose,onError}:{user:any;space:{id:string;name:string;role:string;access_mode?:string};onClose:()=>void;onError:(error:unknown)=>void}) {
  const dialog=useDialog(onClose);
  return <div className="modal academic-modal"><section ref={dialog} className="academic-settings knowledge-permissions-dialog" role="dialog" aria-label={translateUI("知识库权限")} aria-modal="true"><header><h2>{translateUI("知识库权限")}</h2><DialogClose onClick={onClose}/></header><div className="settings-body"><Members session={{user}} space={space} onError={onError} /></div></section></div>;
}
