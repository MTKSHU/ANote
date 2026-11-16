import {useState} from "react";

export function useNoteListPreferences(serverURL:string,userId:string,libraryId:string) {
  const widthKey=`simple-notes:note-list-width:${serverURL}:${userId}`;
  const folderKey=`simple-notes:note-list-folders:${serverURL}:${userId}:${libraryId}`;
  function readWidth(){try{const value=Number(localStorage.getItem(widthKey));return value>=176&&value<=480?value:208;}catch{return 208;}}
  function readFolders():Set<string>{try{const value=JSON.parse(localStorage.getItem(folderKey)||"[]");return new Set(Array.isArray(value)?value.filter(id=>typeof id==="string"):[]);}catch{return new Set();}}
  const [widthState,setWidthState]=useState(()=>({key:widthKey,value:readWidth()}));
  const [foldersState,setFoldersState]=useState(()=>({key:folderKey,value:readFolders()}));
  const width=widthState.key===widthKey?widthState.value:readWidth();
  const closed=foldersState.key===folderKey?foldersState.value:readFolders();
  function setWidth(value:number,persist=true){setWidthState({key:widthKey,value});if(persist)try{localStorage.setItem(widthKey,String(value));}catch{}}
  function toggleFolder(id:string){const next=new Set(closed);next.has(id)?next.delete(id):next.add(id);setFoldersState({key:folderKey,value:next});try{localStorage.setItem(folderKey,JSON.stringify([...next]));}catch{}}
  return {width,setWidth,closed,toggleFolder};
}
