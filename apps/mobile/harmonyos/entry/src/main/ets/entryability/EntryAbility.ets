import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
export default class EntryAbility extends UIAbility {
  onCreate(): void { webview.WebviewController.initializeWebEngine(); }
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index');
  }
}
