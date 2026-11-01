import { t as translateUI } from "@anote/i18n";
import React from "react";
import { Icon } from "./icons";

export function NotePanelHeader({ title, count, actions, className = "", onClose }: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  className?: string;
  onClose: () => void;
}) {
  return <div className={"note-panel-header " + className}>
    <strong>{title}{count !== undefined && <small>{count}</small>}</strong>
    {actions}
    <button type="button" className="note-panel-close" aria-label={translateUI("收起侧栏")} title={translateUI("收起侧栏")} onClick={onClose}><Icon name="close" size={17}/></button>
  </div>;
}
