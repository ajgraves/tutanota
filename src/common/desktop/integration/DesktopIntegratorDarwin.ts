import type { BaseWindow, KeyboardEvent, MenuItemConstructorOptions } from "electron"
import type { WindowManager } from "../DesktopWindowManager"
import { lang } from "../../misc/LanguageViewModel"
import type { DesktopIntegrator } from "./DesktopIntegrator"
import { ElectronExports } from "../ElectronExportTypes"

export class DesktopIntegratorDarwin implements DesktopIntegrator {
	_electron: ElectronExports

	constructor(electron: ElectronExports) {
		this._electron = electron
	}

	isAutoLaunchEnabled(): Promise<boolean> {
		return Promise.resolve(this._electron.app.getLoginItemSettings().openAtLogin)
	}

	enableAutoLaunch(): Promise<void> {
		return this.isAutoLaunchEnabled().then((enabled) => {
			if (!enabled)
				this._electron.app.setLoginItemSettings({
					openAtLogin: true,
				})
		})
	}

	disableAutoLaunch(): Promise<void> {
		return this.isAutoLaunchEnabled().then((enabled) => {
			if (enabled)
				this._electron.app.setLoginItemSettings({
					openAtLogin: false,
				})
		})
	}

	runIntegration(wm: WindowManager): Promise<void> {
		// We need menu on macOS, otherwise there are no shortcuts defined even for things like copy/paste or hiding window
		// this needs to be registered here because it's called after the app ready event
		const template: Array<MenuItemConstructorOptions> = [
			{
				// Skip individual definitions because appMenu can do it automatically
				role: "appMenu",
			},
			{
				label: "Edit",
				submenu: [
					{
						role: "undo",
					},
					{
						role: "redo",
					},
					{
						type: "separator",
					},
					{
						role: "cut",
					},
					{
						role: "copy",
					},
					{
						role: "paste",
					},
					{
						role: "pasteAndMatchStyle",
					},
					{
						role: "delete",
					},
					{
						role: "selectAll",
					},
					{
						type: "separator",
					},
					{
						label: "Speech",
						submenu: [
							{
								role: "startSpeaking",
							},
							{
								role: "stopSpeaking",
							},
						],
					},
				],
			},
			{
				label: "View",
				submenu: [
					{
						role: "togglefullscreen",
					},
				],
			},
			{
				role: "window",
				submenu: [
					{
						role: "close",
					},
					{
						role: "minimize",
					},
					{
						role: "zoom",
					},
					{
						type: "separator",
					},
					{
						role: "front",
					},
					{
						click: (_, window, event) => this.emitZoomEvent(wm, window, event, "in"),
						label: lang.get("zoomIn_action"),
						accelerator: "Command+=",
						enabled: true,
					},
					{
						click: (_, window, event) => this.emitZoomEvent(wm, window, event, "out"),
						label: lang.get("zoomOut_action"),
						accelerator: "Command+-",
						enabled: true,
					},
					{
						click: (_, window, event) => this.emitZoomEvent(wm, window, event, "in"),
						label: lang.get("zoomIn_action"),
						accelerator: "Command+Shift+=",
						enabled: true,
						visible: false,
						acceleratorWorksWhenHidden: true,
					},
					{
						click: (_, window, event) => this.emitZoomEvent(wm, window, event, "out"),
						label: lang.get("zoomOut_action"),
						accelerator: "Command+Shift+-",
						enabled: true,
						visible: false,
						acceleratorWorksWhenHidden: true,
					},
					{
						role: "resetZoom",
					},
					{
						click: () => {
							wm.newWindow(true)
						},
						label: lang.get("openNewWindow_action"),
						accelerator: "Command+N",
						enabled: true,
					},
				],
			},
		]

		const menu = this._electron.Menu.buildFromTemplate(template)

		this._electron.Menu.setApplicationMenu(menu)

		return Promise.resolve()
	}

	private emitZoomEvent(wm: WindowManager, baseWindow: BaseWindow | undefined, event: KeyboardEvent, direction: "in" | "out"): void {
		if (baseWindow == null) {
			return
		}
		wm.get(baseWindow.id)?._browserWindow.webContents.emit("zoom-changed", event, direction)
	}

	isIntegrated(): Promise<boolean> {
		return Promise.resolve(true)
	}

	integrate(): Promise<void> {
		return Promise.resolve()
	}

	unintegrate(): Promise<void> {
		return Promise.resolve()
	}
}
