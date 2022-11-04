import m, {Children, Component, Vnode} from "mithril"
import {Dialog} from "../../gui/base/Dialog.js"
import type {TableAttrs, TableLineAttrs} from "../../gui/base/Table.js"
import {ColumnWidth, Table} from "../../gui/base/Table.js"
import {lang, TranslationKey} from "../../misc/LanguageViewModel.js"
import {InvalidDataError, LimitReachedError, PreconditionFailedError} from "../../api/common/error/RestError.js"
import {firstThrow, ofClass} from "@tutao/tutanota-utils"
import {SelectMailAddressForm} from "../SelectMailAddressForm.js"
import {logins} from "../../api/main/LoginController.js"
import {Icons} from "../../gui/base/icons/Icons.js"
import {showProgressDialog} from "../../gui/dialogs/ProgressDialog.js"
import * as EmailAliasOptionsDialog from "../../subscription/EmailAliasOptionsDialog.js"
import {getAvailableDomains} from "../AddUserDialog.js"
import stream from "mithril/stream"
import {ExpanderButton, ExpanderPanel} from "../../gui/base/Expander.js"
import {attachDropdown} from "../../gui/base/Dropdown.js"
import {TUTANOTA_MAIL_ADDRESS_DOMAINS} from "../../api/common/TutanotaConstants.js"
import type {GroupInfo, MailAddressAlias} from "../../api/entities/sys/TypeRefs.js"
import {showNotAvailableForFreeDialog} from "../../misc/SubscriptionDialogs.js"
import {locator} from "../../api/main/MainLocator.js"
import {assertMainOrNode} from "../../api/common/Env.js"
import {isTutanotaMailAddress} from "../../mail/model/MailUtils.js";
import {IconButtonAttrs} from "../../gui/base/IconButton.js"
import {ButtonSize} from "../../gui/base/ButtonSize.js";
import {createMailAddressProperties, MailboxProperties} from "../../api/entities/tutanota/TypeRefs.js"
import {getSenderName} from "../../misc/MailboxPropertiesUtils.js"

assertMainOrNode()

const FAILURE_USER_DISABLED = "mailaddressaliasservice.group_disabled"

export type MailAddressTableAttrs = {
	userGroupInfo: GroupInfo
	aliasCount: AliasCount
	mailboxProperties: MailboxProperties
}

type AliasCount = {
	availableToCreate: number
	availableToEnable: number
}

/** Shows a table with all aliases and ability to enable/disable them and add more. */
export class MailAddressTable implements Component<MailAddressTableAttrs> {
	private expanded: boolean = false

	view(vnode: Vnode<MailAddressTableAttrs>): Children {
		const a = vnode.attrs
		const addAliasButtonAttrs: IconButtonAttrs = {
			title: "addEmailAlias_label",
			click: () => this._showAddAliasDialog(a),
			icon: Icons.Add,
			size: ButtonSize.Compact
		}
		const aliasesTableAttrs: TableAttrs = {
			columnHeading: ["emailAlias_label", "state_label"],
			columnWidths: [ColumnWidth.Largest, ColumnWidth.Small],
			showActionButtonColumn: true,
			addButtonAttrs: addAliasButtonAttrs,
			lines: getAliasLineAttrs(a),
		}
		return [
			m(".flex-space-between.items-center.mt-l.mb-s", [
				m(".h4", lang.get("mailAddressAliases_label")),
				m(ExpanderButton, {
					label: "showEmailAliases_action",
					expanded: this.expanded,
					onExpandedChange: (v) => this.expanded = v
				}),
			]),
			m(ExpanderPanel, {
					expanded: this.expanded,
				},
				m(Table, aliasesTableAttrs),
			),
			m(
				".small",
				a.aliasCount.availableToCreate === 0
					? lang.get("adminMaxNbrOfAliasesReached_msg")
					: lang.get("mailAddressAliasesMaxNbr_label", {
						"{1}": a.aliasCount.availableToCreate,
					}),
			),
		]
	}

	_showAddAliasDialog(aliasFormAttrs: MailAddressTableAttrs) {
		if (aliasFormAttrs.aliasCount.availableToCreate === 0) {
			if (logins.getUserController().isFreeAccount()) {
				showNotAvailableForFreeDialog(true)
			} else {
				Dialog.confirm(() => lang.get("adminMaxNbrOfAliasesReached_msg") + " " + lang.get("orderAliasesConfirm_msg")).then(confirmed => {
					if (confirmed) {
						// Navigate to subscriptions folder and show alias options
						m.route.set("/settings/subscription")
						EmailAliasOptionsDialog.show()
					}
				})
			}
		} else {
			getAvailableDomains().then(domains => {
				let isVerificationBusy = false
				let mailAddress: string
				let formErrorId: TranslationKey | null = "mailAddressNeutral_msg"
				let formDomain = stream(firstThrow(domains))

				const addEmailAliasOkAction = (dialog: Dialog) => {
					if (isVerificationBusy) return

					if (formErrorId) {
						Dialog.message(formErrorId)
						return
					}

					addAlias(aliasFormAttrs, mailAddress)
					// close the add alias dialog immediately
					dialog.close()
				}

				const isTutanotaDomain = formDomain.map(d => TUTANOTA_MAIL_ADDRESS_DOMAINS.includes(d))
				Dialog.showActionDialog({
					title: lang.get("addEmailAlias_label"),
					child: {
						view: () => {
							return [
								m(SelectMailAddressForm, {
									availableDomains: domains,
									onValidationResult: (email, validationResult) => {
										if (validationResult.isValid) {
											mailAddress = email
											formErrorId = null
										} else {
											formErrorId = validationResult.errorId
										}
									},
									onBusyStateChanged: isBusy => (isVerificationBusy = isBusy),
									onDomainChanged: domain => formDomain(domain),
								}),
								m(ExpanderPanel, {
										expanded: isTutanotaDomain(),
									},
									m(".pt-m", lang.get("permanentAliasWarning_msg")),
								),
							]
						},
					},
					allowOkWithReturn: true,
					okAction: addEmailAliasOkAction,
				})
			})
		}
	}
}

export function getAliasLineAttrs(editAliasAttrs: MailAddressTableAttrs): Array<TableLineAttrs> {
	return editAliasAttrs.userGroupInfo.mailAddressAliases
						 .slice()
						 .sort((a, b) => (a.mailAddress > b.mailAddress ? 1 : -1))
						 .map(alias => {
							 const actionButtonAttrs: IconButtonAttrs = attachDropdown(
								 {
									 mainButtonAttrs: {
										 title: "edit_action",
										 icon: Icons.More,
										 size: ButtonSize.Compact,
									 },
									 showDropdown: () => true,
									 width: 250,
									 childAttrs: () => [
										 {
											 // FIXME
											 label: () => "Set name",
											 click: () => showSenderNameChangeDialog(alias, editAliasAttrs.mailboxProperties)
										 },
										 {
											 label: "activate_action",
											 click: () => {
												 if (!alias.enabled) {
													 switchAliasStatus(alias, editAliasAttrs)
												 }
											 },
											 selected: alias.enabled,
										 },
										 {
											 label: isTutanotaMailAddress(alias.mailAddress) ? "deactivate_action" : "delete_action",
											 click: () => {
												 if (alias.enabled) {
													 switchAliasStatus(alias, editAliasAttrs)
												 }
											 },
											 isSelected: !alias.enabled,
										 },
									 ],
								 },
							 )
							 const name = getSenderName(editAliasAttrs.mailboxProperties, alias.mailAddress)
							 return {
								 cells: () => [
									 {main: alias.mailAddress, info: [name ?? ""]},
									 {main: alias.enabled ? lang.get("activated_label") : lang.get("deactivated_label")},
								 ],
								 actionButtonAttrs: actionButtonAttrs,
							 }
						 })
}

function switchAliasStatus(alias: MailAddressAlias, editAliasAttrs: MailAddressTableAttrs) {
	let restore = !alias.enabled
	let promise = Promise.resolve(true)

	if (!restore) {
		const message: TranslationKey = isTutanotaMailAddress(alias.mailAddress) ? "deactivateAlias_msg" : "deleteAlias_msg"
		promise = Dialog.confirm(() =>
			lang.get(message, {
				"{1}": alias.mailAddress,
			}),
		)
	}

	promise.then(confirmed => {
		if (confirmed) {
			let p = locator.mailAddressFacade
						   .setMailAliasStatus(editAliasAttrs.userGroupInfo.group, alias.mailAddress, restore)
						   .catch(
							   ofClass(LimitReachedError, e => {
								   Dialog.message("adminMaxNbrOfAliasesReached_msg")
							   }),
						   )
						   .finally(() => updateNbrOfAliases(editAliasAttrs))
			showProgressDialog("pleaseWait_msg", p)
		}
	})
}

function showSenderNameChangeDialog(alias: MailAddressAlias, mailboxProperties: MailboxProperties) {
	const currentName = getSenderName(mailboxProperties, alias.mailAddress)
	// FIXME translate
	Dialog.showTextInputDialog(
		() => "Sender name",
		// FIXME
		"name_label",
		() => alias.mailAddress,
		currentName ?? ""
	).then((newName) => showProgressDialog("pleaseWait_msg", setAliasName(alias, mailboxProperties, newName)))
}

async function setAliasName(alias: MailAddressAlias, mailboxProperties: MailboxProperties, senderName: string) {
	let aliasConfig = mailboxProperties.mailAddressProperties.find((p) => p.mailAddress === alias.mailAddress)
	if (aliasConfig == null) {
		aliasConfig = createMailAddressProperties({mailAddress: alias.mailAddress})
		mailboxProperties.mailAddressProperties.push(aliasConfig)
	}
	aliasConfig.senderName = senderName
	await locator.entityClient.update(mailboxProperties)
}

export function addAlias(aliasFormAttrs: MailAddressTableAttrs, alias: string): Promise<void> {
	return showProgressDialog("pleaseWait_msg", locator.mailAddressFacade.addMailAlias(aliasFormAttrs.userGroupInfo.group, alias))
		.catch(ofClass(InvalidDataError, () => Dialog.message("mailAddressNA_msg")))
		.catch(ofClass(LimitReachedError, () => Dialog.message("adminMaxNbrOfAliasesReached_msg")))
		.catch(
			ofClass(PreconditionFailedError, e => {
				let errorMsg = e.toString()

				if (e.data === FAILURE_USER_DISABLED) {
					errorMsg = lang.get("addAliasUserDisabled_msg")
				}

				return Dialog.message(() => errorMsg)
			}),
		)
		.finally(() => updateNbrOfAliases(aliasFormAttrs))
}

export function updateNbrOfAliases(attrs: MailAddressTableAttrs): Promise<AliasCount> {
	return locator.mailAddressFacade.getAliasCounters().then(mailAddressAliasServiceReturn => {
		const newNbr = Math.max(0, Number(mailAddressAliasServiceReturn.totalAliases) - Number(mailAddressAliasServiceReturn.usedAliases))
		const newNbrToEnable = Math.max(0, Number(mailAddressAliasServiceReturn.totalAliases) - Number(mailAddressAliasServiceReturn.enabledAliases))
		attrs.aliasCount = {
			availableToCreate: newNbr,
			availableToEnable: newNbrToEnable,
		}
		m.redraw()
		return attrs.aliasCount
	})
}

export function createEditAliasFormAttrs(userGroupInfo: GroupInfo, mailboxProperties: MailboxProperties): MailAddressTableAttrs {
	return {
		userGroupInfo,
		mailboxProperties,
		aliasCount: {
			availableToEnable: 0,
			availableToCreate: 0,
		},
	}
}