//@flow
import type {CalendarEvent} from "../../api/entities/tutanota/CalendarEvent"
import m from "mithril"
import {Icon} from "../../gui/base/Icon"
import {theme} from "../../gui/theme"
import {BootIcons} from "../../gui/base/icons/BootIcons"
import {Icons} from "../../gui/base/icons/Icons"
import {iconForAttendeeStatus} from "./CalendarEventEditDialog"
import {formatEventDuration, getTimeZone} from "../CalendarUtils"
import {attendeeStatusByCode} from "../../api/common/TutanotaConstants"

export type Attrs = {
	event: CalendarEvent,
	limitDescriptionHeight: boolean,
	sanitizedDescription: string,
}

export class EventPreviewView implements MComponent<Attrs> {

	view({attrs: {event, limitDescriptionHeight, sanitizedDescription}}: Vnode<Attrs>): Children {
		return m(".flex.col", [
			m(".flex.col.smaller", [
				m(".flex.pb-s.items-center", [renderSectionIndicator(BootIcons.Calendar), m(".h3", event.summary)]),
				m(".flex.pb-s.items-center", [
						renderSectionIndicator(Icons.Time),
						m(".align-self-center", formatEventDuration(event, getTimeZone(), false))
					]
				),
				event.location ? m(".flex.pb-s.items-center", [renderSectionIndicator(Icons.Pin), m(".text-ellipsis", event.location)]) : null,
				event.attendees.length
					? m(".flex.pb-s", [
						renderSectionIndicator(BootIcons.Contacts),
						m(".flex-wrap", event.attendees.map(a => m(".flex.items-center", [
							m(Icon, {
								icon: iconForAttendeeStatus[attendeeStatusByCode[a.status]],
								style: {fill: theme.content_fg},
								class: "mr-s"
							}),
							m(".span.line-break-anywhere", a.address.address),
						]))),
					])
					: null,
				!!event.description
					? m(".flex.pb-s.items-start", [
						renderSectionIndicator(Icons.AlignLeft, {marginTop: "2px"}),
						limitDescriptionHeight
							? m(".scroll.full-width", {style: {maxHeight: "100px"}}, m.trust(sanitizedDescription))
							: m("", m.trust(sanitizedDescription))
					])
					: null,
			]),
		])
	}
}


function renderSectionIndicator(icon, style: {[string]: any} = {}) {
	return m(".pr", m(Icon, {
		icon,
		large: true,
		style: Object.assign({
			fill: theme.content_button,
			display: "block"
		}, style)
	}))
}