export const longMapText="这是一段较长的思维导图节点文字，导出时应完整保留每一个字符，不能截断";
export const exportNodes=()=>[
  {type:"heading",attrs:{level:2},content:[{type:"text",text:"实验结论"}]},
  {type:"paragraph",attrs:{textAlign:"center"},content:[{type:"text",text:"自定义样式应保留",marks:[{type:"textStyle",attrs:{fontSize:20,color:"#a61d24",backgroundColor:"#fff2cc"}}]}]},
  {type:"blockquote",content:[{type:"paragraph",content:[{type:"text",text:"引用区使用浅底和左侧竖线，与正文保持清晰区分。"}]}]},
  {type:"paragraph",content:[{type:"text",text:"加粗斜体",marks:[{type:"bold"},{type:"italic"}]},{type:"hardBreak"},{type:"text",text:"论文链接",marks:[{type:"link",attrs:{href:"https://example.org/paper"}}]}]},
  {type:"paragraph",content:[{type:"text",text:"<script>window.__exportInjection=1</script><img src=x onerror=window.__exportInjection=1>"}]},
  {type:"orderedList",attrs:{start:3},content:[{type:"listItem",content:[{type:"paragraph",content:[{type:"text",text:"可重复实验"}]}]}]},
  {type:"taskList",content:[{type:"taskItem",attrs:{checked:true},content:[{type:"paragraph",content:[{type:"text",text:"已经完成的任务"}]}]}]},
  {type:"table",content:[{type:"tableRow",content:[{type:"tableHeader",attrs:{colspan:2,colwidth:[160,320]},content:[{type:"paragraph",content:[{type:"text",text:"合并单元格"}]}]}]},{type:"tableRow",content:[{type:"tableCell",attrs:{background:"#e8f4ea"},content:[{type:"paragraph",content:[{type:"text",text:"条件 A"}]}]},{type:"tableCell",content:[{type:"paragraph",content:[{type:"text",text:"条件 B"}]}]}]}]},
  {type:"mathBlock",attrs:{latex:"X_t=\\frac{a}{b}"}},
  {type:"codeBlock",attrs:{language:"python"},content:[{type:"text",text:"if True:\n    print('第一行')\n    print('第二行')"}]},
  {type:"mindMap",attrs:{canvasHeight:420},content:[{type:"mindMapItem",attrs:{id:"root",parentId:null,x:200,y:100},content:[{type:"text",text:"导出中心主题"}]},{type:"mindMapItem",attrs:{id:"branch",parentId:"root",x:500,y:240},content:[{type:"text",text:longMapText}]}]},
  {type:"codeBlock",attrs:{language:"mermaid"},content:[{type:"text",text:"flowchart LR\nA[导出完整图表] --> B[图片可独立查看]"}]},
];
