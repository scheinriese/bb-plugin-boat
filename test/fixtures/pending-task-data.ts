// Neutral task-detail sample for standalone rendering; no provider operations.
import type { TaskDetailDto } from "../../contract";
import type { OwnMacNotice } from "../../contract-ownmac";
export const pendingTaskSample: TaskDetailDto = {
  id:"t_fa123456",orchestratorThreadId:"fake-source",projectId:null,title:"Test the sample native app",compactTitle:null,purpose:null,designClaudePreference:false,
  claudePaidContinuation:false,source:{kind:"chat",threadId:"fake-source",title:"Native app testing"},role:"custom",provider:"codex",model:"gpt-6.1-sol",tier:"build",reasoningEffort:"xhigh",reason:null,
  repo:"acme/sample",branch:"boat/fake-pending-branch",baseBranch:"main",sandboxId:null,conversationId:null,
  status:"failed",runner:"chat",threadId:null,phase:"waiting",macRentalPending:true,readyNote:null,latestReview:null,previewUrl:null,
  delivery:"pr",unshipped:false,canShip:false,untrustedRepo:false,movingToChat:false,parentTaskId:null,prUrl:null,error:null,
  turns:0,ownsSandbox:true,createdAt:"2026-11-20T12:30:00Z",updatedAt:"2026-11-20T12:30:00Z",finishedAt:null,reportStatus:null,verdict:null,excerpt:null,
  publicStatus:{status:"needs-you",label:"Waiting for your choice",reason:"Choose a Mac rental before this task starts.",needsYou:true,tone:"attention",moving:false},
  brief:"Run the sample native app and check its main window, keyboard shortcuts and settings. Report the checks and screenshots.",result:null,events:[],dashboardUrl:null,memory:null,shipApproval:null,
};
const quote = {id:"fake-scaleway",provider:"scaleway",label:"Scaleway",model:"fake-m4",modelLabel:"Mac mini M4",cpus:8,memoryMiB:16384,region:"fr-par-3",checkedAt:"2026-11-20T12:30:00Z",minimumCost:5.28,minimumHours:24,hourPrice:.22,currency:"EUR",expiresAt:"2099-01-01T00:00:00Z"};
export const pendingRentalSample: OwnMacNotice = {
  taskId:pendingTaskSample.id,title:pendingTaskSample.title,alias:"",reason:"unavailable",offer:quote,
  offers:[{id:"fake-instabox",provider:"instabox",label:"Instabox",model:"fake-m2",modelLabel:"Mac M2",cpus:8,memoryMiB:8192,checkedAt:"2026-11-20T12:30:00Z",minimumCost:10.8,minimumHours:24,hourPrice:.45,currency:"USD",expiresAt:"2099-01-01T00:00:00Z"},quote],
  recommendedQuoteId:quote.id,recommendationReason:"Project preference: Scaleway.",canWaitForOwnMac:false,
};
