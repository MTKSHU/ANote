import { common, bundleManager } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { webview } from '@kit.ArkWeb';
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { promptAction } from '@kit.ArkUI';
import { PREVIEW_ORIGIN } from '../common/Preview';
import { parseOrigin, downloadOrigin, validateServer, isAuthStart, safeFilename } from '../common/OriginPolicy';

@Entry
@Component
struct Index {
  @State private address: string = PREVIEW_ORIGIN;
  @State private server: string = '';
  @State private currentOrigin: string = '';
  @State private notice: string = '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private downloads: webview.WebDownloadDelegate = new webview.WebDownloadDelegate();
  private authenticationFlow: boolean = false;
  private authenticationOrigins: string[] = [];
  private pref: preferences.Preferences | undefined = undefined;
  private context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;

  async aboutToAppear(): Promise<void> {
    try {
      this.pref = await preferences.getPreferences(this.context, { name: 'anote-server' });
      this.address = await this.pref.get('server', PREVIEW_ORIGIN) as string;
      // Always show the selector; opening the app itself makes no network request.
    } catch { this.notice = '无法读取服务器设置，请重新输入。'; }
    this.downloads.onBeforeDownload((item: webview.WebDownloadItem) => {
      const downloadUrl = item.getUrl();
      if (downloadOrigin(downloadUrl) !== this.server) { item.cancel(); this.notice = '只允许下载当前 ANote 服务器上的附件'; return; }
      const directory = this.context.cacheDir + '/anote-downloads';
      try { fs.mkdirSync(directory); } catch { /* existing cache directory */ }
      item.start(directory + '/' + Date.now().toString() + '-' + safeFilename(item.getSuggestedFileName()));
    });
    this.downloads.onDownloadFinish((item: webview.WebDownloadItem) => { this.saveDownload(item); });
    this.downloads.onDownloadFailed((item: webview.WebDownloadItem) => {
      this.notice = '附件下载失败，请检查网络或重新登录。';
      try { fs.unlinkSync(item.getFullPath()); } catch { /* absent partial file */ }
    });
  }
  private async connect(): Promise<void> {
    try {
      const origin = validateServer(this.address);
      const previousCookieOrigin = await this.pref?.get('cookie-origin', '') as string;
      if (previousCookieOrigin !== origin) {
        await webview.WebCookieManager.clearAllCookies();
        webview.WebStorage.deleteAllData();
        await this.pref?.put('cookie-origin', origin);
      }
      this.notice = '';
      this.currentOrigin = origin;
      this.server = origin;
      await this.pref?.put('server', origin);
      await this.pref?.flush();
    } catch { this.notice = '服务器地址无效。请输入 HTTPS 地址，或本次构建指定的隔离测试地址。'; }
  }
  private async confirmAuthentication(destination: string, target: string): Promise<void> {
    const result = await promptAction.showDialog({ title: '继续统一登录', message: '请确认这是你的团队认证服务器：\n' + destination,
      buttons: [{ text: '取消', color: '#64748B' }, { text: '继续', color: '#4864C6' }] });
    if (result.index === 1) { this.authenticationOrigins.push(destination); this.controller.loadUrl(target); }
    else { this.authenticationFlow = false; this.controller.loadUrl(this.server + '/'); }
  }
  private navigate(request: WebResourceRequest): boolean {
    const target = request.getRequestUrl();
    if (target.startsWith('blob:') && this.currentOrigin === this.server && downloadOrigin(target) === this.server) return false;
    const origin = parseOrigin(target);
    if (!request.isMainFrame()) return !origin && target !== 'about:blank' && !target.startsWith('blob:');
    if (origin === this.server) {
      if (isAuthStart(target, this.server)) this.authenticationFlow = true;
      return false;
    }
    if (!origin || !origin.startsWith('https://')) { this.notice = '已阻止不受信任的页面地址'; return true; }
    if (this.authenticationFlow) {
      if (this.authenticationOrigins.includes(origin)) return false;
      this.confirmAuthentication(origin, target);
      return true;
    }
    promptAction.showDialog({ title: '在浏览器打开链接', message: origin,
      buttons: [{ text: '取消', color: '#64748B' }, { text: '打开', color: '#4864C6' }] }).then((result) => {
      if (result.index === 1) this.context.startAbility({ action: 'ohos.want.action.viewData', uri: target });
    }).catch(() => { this.notice = '无法打开系统浏览器'; });
    return true;
  }
  private async saveDownload(item: webview.WebDownloadItem): Promise<void> {
    const source = item.getFullPath();
    try {
      if (downloadOrigin(item.getUrl()) !== this.server) {
        this.notice = '已拒绝其他服务器重定向的附件';
        return;
      }
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [safeFilename(item.getSuggestedFileName())];
      const targets = await new picker.DocumentViewPicker(this.context).save(options);
      if (targets.length > 0) {
        const file = fs.openSync(targets[0], fs.OpenMode.READ_WRITE);
        try { fs.copyFileSync(source, file.fd); } finally { fs.closeSync(file); }
        promptAction.showToast({ message: '附件已保存' });
      }
    } catch { this.notice = '附件未保存，请重试。'; }
    finally { try { fs.unlinkSync(source); } catch { /* no cache left */ } }
  }
  private async chooseFiles(event: OnShowFileSelectorEvent): Promise<void> {
    try {
      if (parseOrigin(this.controller.getUrl()) !== this.server) { event.result.handleFileList([]); return; }
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = event.fileSelector.getMode() === FileSelectorMode.FileOpenMultipleMode ? 20 : 1;
      const selected = await new picker.DocumentViewPicker(this.context).select(options);
      event.result.handleFileList(selected);
    } catch { event.result.handleFileList([]); }
  }
  private async switchServer(): Promise<void> {
    const result = await promptAction.showDialog({ title: '切换服务器', message: '请确认笔记已经保存，再离开当前服务器。',
      buttons: [{ text: '取消', color: '#64748B' }, { text: '继续', color: '#4864C6' }] });
    if (result.index === 1) { this.server = ''; this.authenticationFlow = false; this.authenticationOrigins = []; this.notice = ''; }
  }
  onBackPress(): boolean {
    if (this.server && this.currentOrigin === this.server) {
      this.controller.runJavaScript("(()=>{const event=new Event('anote:mobile-back',{cancelable:true});return !window.dispatchEvent(event);})()")
        .then((consumed: string) => { if (consumed !== 'true') this.navigateBack(); })
        .catch(() => { this.navigateBack(); });
      return true;
    }
    return this.navigateBack();
  }
  private navigateBack(): boolean {
    if (this.server && this.controller.accessBackward()) { this.controller.backward(); return true; }
    if (this.server) { this.switchServer(); return true; }
    return false;
  }
  build() {
    Column() {
      if (!this.server) {
        Column({ space: 20 }) {
          Text('ANote · ' + bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION).versionName + ' 预览').fontSize(28).fontWeight(FontWeight.Bold).width('100%')
          Text('连接你的 ANote 服务器。登录、笔记与附件只发送到你选择的服务器。').fontSize(16)
          TextInput({ text: this.address, placeholder: 'https://你的服务器' }).type(InputType.URL).onChange((value: string) => { this.address = value; })
          Button('连接服务器').width('100%').onClick(() => { this.connect(); })
          Text('内部测试客户端。HTTP 预览只使用隔离测试账号；首次打开不会自动连接。').fontSize(13).fontColor('#64748B')
          if (this.notice) { Text(this.notice).fontColor('#B91C1C') }
        }.padding(24).justifyContent(FlexAlign.Center).layoutWeight(1)
      } else {
        Row() {
          Button('‹').width(44).height(44).onClick(() => { this.onBackPress(); })
          Text(this.currentOrigin).fontSize(12).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
          Button('⋮').width(44).height(44).bindMenu([
            { value: '刷新页面', action: () => { this.controller.refresh(); } },
            { value: '切换服务器', action: () => { this.switchServer(); } }
          ])
        }.width('100%')
        if (this.notice) { Text(this.notice).fontColor('#B91C1C').fontSize(13).padding(8).onClick(() => { this.controller.refresh(); }) }
        Web({ src: this.server + '/', controller: this.controller })
          .javaScriptAccess(true).domStorageAccess(true).fileAccess(false).geolocationAccess(false)
          .mixedMode(MixedMode.None).multiWindowAccess(false).allowWindowOpenMethod(false)
          .onControllerAttached(() => { this.controller.setDownloadDelegate(this.downloads); })
          .onLoadIntercept((event: OnLoadInterceptEvent): boolean => {
            if (!event) return true;
            const request = event.data;
            if (request.isMainFrame()) return this.navigate(request);
            const origin = parseOrigin(request.getRequestUrl());
            return request.getRequestUrl().startsWith('http:') && origin !== this.server;
          })
          .onPageBegin((event: OnPageBeginEvent): void => {
            if (!event) return;
            this.currentOrigin = parseOrigin(event.url);
            this.notice = '';
            if (isAuthStart(event.url, this.server)) this.authenticationFlow = true;
            if (parseOrigin(event.url) === this.server && (event.url.includes('auth_success=') || event.url.includes('auth_error='))) {
              this.authenticationFlow = false; this.authenticationOrigins = [];
            }
          })
          .onSslErrorEventReceive((event: OnSslErrorEventReceiveEvent): void => { event?.handler.handleCancel(); this.notice = 'HTTPS 证书无效，连接已取消。'; })
          .onErrorReceive((event: OnErrorReceiveEvent): void => { if (event?.request.isMainFrame()) this.notice = '连接失败，请检查网络后轻触此处重试。'; })
          .onPermissionRequest((event: OnPermissionRequestEvent): void => { event?.request.deny(); })
          .onShowFileSelector((event: OnShowFileSelectorEvent): boolean => { if (event) this.chooseFiles(event); return true; })
          .layoutWeight(1).width('100%')
      }
    }.height('100%').width('100%').backgroundColor('#F8FAFC')
  }
}
