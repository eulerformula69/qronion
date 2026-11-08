from pathlib import Path

from app.models import Service, Ticket, Window
from app.services.tickets import build_ticket_called_event


ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_board_html_loads_profiles_before_board_script():
    source = _read("queue/board.html")
    bootstrap = _read("queue/js/board-bootstrap.js")

    assert '<script src="/queue/js/board-bootstrap.js?v=board-profile-8"></script>' in source
    assert 'loadScript("/queue/js/board-profiles.js")' in bootstrap
    assert bootstrap.index('/queue/js/board-profiles.js') < bootstrap.index('/queue/js/board.js')


def test_board_profiles_normalize_screen_values_and_enable_popup_only_for_screen_2():
    source = _read("queue/js/board-profiles.js")

    assert "const BOARD_PROFILES" in source
    assert "callPopup: false" in source
    assert "callHighlight: true" in source
    assert '"2": {' in source
    assert "callPopup: true" in source
    assert "callHighlight: false" in source
    assert 'value === "1"' in source
    assert 'return "default";' in source
    assert 'new URLSearchParams(window.location.search).get("screen")' in source


def test_media_screen_uses_standard_board_with_media_profile():
    page = _read("queue/board.html")
    profiles = _read("queue/js/board-profiles.js")
    bootstrap = _read("queue/js/board-bootstrap.js")

    assert '<video id="media-video" autoplay playsinline></video>' in page
    assert 'media: {' in profiles
    assert 'layout: "media"' in profiles
    assert 'calledPageSize: 5' in profiles
    assert 'waitingPageSize: 5' in profiles
    assert 'showLabels: false' in profiles
    assert 'shouldShowLabels()' in profiles
    assert 'screen === "media"' in bootstrap
    assert 'showLabels: false' in bootstrap
    assert 'callAudioEnabled: getBooleanFlag("call_audio", true)' in bootstrap
    assert 'videoAudioEnabled: getBooleanFlag("video_audio", true)' in bootstrap
    assert 'loadScript("/queue/js/media-lite.js?v=board-profile-7")' in bootstrap
    assert 'loadScript("/queue/js/tts-lite.js?v=board-profile-7")' in bootstrap
    assert 'loadScript("/queue/js/board-lite.js?v=board-recovery-1")' in bootstrap
    assert 'loadScript("/queue/js/board.js?v=board-recovery-1")' in bootstrap


def test_media_profile_hides_ticket_and_operator_labels_in_cards():
    board = _read("queue/js/board.js")
    lite_board = _read("queue/js/board-lite.js")

    assert "!window.BoardProfiles.shouldShowLabels()" in board
    assert "left: number" in board
    assert "right: windowName" in board
    assert "const ticketText" in board
    assert "var SHOW_LABELS" in lite_board
    assert "window.BOARD_CONFIG.showLabels !== false" in lite_board


def test_media_audio_flags_control_ticket_announcements_and_video_sound():
    bootstrap = _read("queue/js/board-bootstrap.js")
    lite_board = _read("queue/js/board-lite.js")
    media = _read("queue/js/media-lite.js")

    assert 'getBooleanFlag("call_audio", true)' in bootstrap
    assert 'getBooleanFlag("video_audio", true)' in bootstrap
    assert 'window.BOARD_CONFIG.callAudioEnabled !== false' in lite_board
    assert 'typeof window.speakTicketLite === "function"' in lite_board
    assert 'window.speakTicketLite(normalized' in lite_board
    assert "DUPLICATE_CALL_MS = 5000" in lite_board
    assert 'window.BOARD_CONFIG.videoAudioEnabled !== false' in media
    assert "video.muted = !VIDEO_AUDIO_ENABLED" in media


def test_media_tts_uses_web_audio_without_stealing_the_video_element():
    source = _read("queue/js/tts-lite.js")

    assert "window.AudioContext || window.webkitAudioContext" in source
    assert 'request.responseType = "arraybuffer"' in source
    assert "context.decodeAudioData(" in source
    assert "context.createBufferSource()" in source
    assert "new Audio()" not in source


def test_media_board_speaks_only_explicit_call_events_with_server_tts_text():
    source = _read("queue/js/board-lite.js")

    handle_state_start = source.index("function handleBoardState(boardState)")
    handle_recall_start = source.index("function handleRecall(data)")
    handle_state = source[handle_state_start:handle_recall_start]
    handle_recall = source[handle_recall_start:]

    assert "announceTicket(" not in handle_state
    assert "announceTicket(ticket)" in handle_recall
    assert 'tts_text: data.tts_text || srcTicket.tts_text || ""' in handle_recall
    assert "detectAndAnnounceNewTickets" not in source


def test_board_popup_is_triggered_only_by_deduplicated_ticket_called_events_and_can_replace_highlight():
    source = _read("queue/js/board.js")

    ticket_called_index = source.index('if (data.type === "ticket_called")')
    duplicate_index = source.index("processedCallIds.has(data.call_id)", ticket_called_index)
    popup_index = source.index("window.BoardProfiles.handleTicketCalled(data)", ticket_called_index)
    recall_index = source.index('if (data.type === "recall_ticket" || data.ticket_number)')

    assert duplicate_index < popup_index < recall_index
    assert "window.BoardProfiles.handleTicketCalled(data)" in source
    assert "window.BoardProfiles.shouldHighlightCall()" in source


def test_board_popup_uses_safe_dom_text_assignment_and_auto_hides():
    source = _read("queue/js/board-profiles.js")

    assert "POPUP_DURATION_MS = 5500" in source
    assert ".textContent =" in source
    assert ".innerHTML" not in source
    assert "popup.classList.add(\"is-visible\")" in source
    assert "popup.hidden = true" in source


def test_board_popup_uses_single_orange_operator_window_line():
    source = _read("queue/js/board-profiles.js")
    board_css = _read("queue/css/board.css")

    assert 'getCallValue(data, "operator_name")' not in source
    assert 'windowName ? `Оператор ${windowName}` : ""' in source
    assert 'setOptionalText(document.getElementById("board-call-popup-window"), "")' in source
    assert "board-call-popup__service" in source
    assert "board-call-popup__operator" in source
    assert "body.board-page .board-call-popup__service" in board_css
    assert "font-size: clamp(24px, 3vw, 46px);" in board_css
    assert "body.board-page .board-call-popup__operator" in board_css
    assert "font-size: clamp(42px, 5.4vw, 84px);" in board_css
    assert "color: #ff7f50;" in board_css
    assert "white-space: nowrap;" in board_css


def test_ticket_called_payload_contains_popup_fields_without_operator_name():
    ticket = Ticket(id=123, number=45, service_id=7, operator_id=12)
    window = Window(id=3, name="Window 3")
    service = Service(id=7, name="Consultation")
    settings = {
        "call_message_template": "Ticket <number> to <window>",
        "board_ticket_template": "Ticket <number> -> <window>",
    }

    payload = build_ticket_called_event(
        ticket,
        window,
        service=service,
        settings=settings,
        call_id="123:2026-07-10T10:00:00",
    )

    assert payload["type"] == "ticket_called"
    assert payload["ticket_id"] == 123
    assert payload["number"] == 45
    assert payload["service_id"] == 7
    assert payload["service_name"] == "Consultation"
    assert payload["window_id"] == 3
    assert payload["window_name"] == "Window 3"
    assert payload["operator_id"] == 12
    assert "operator_name" not in payload
    assert payload["ticket"]["service_name"] == "Consultation"
    assert "operator_name" not in payload["ticket"]
