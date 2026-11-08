-- Frozen initial schema. Future changes belong in new revisions.

CREATE TABLE admins (
	id SERIAL NOT NULL,
	login VARCHAR,
	password VARCHAR,
	status VARCHAR,
	PRIMARY KEY (id)
);

CREATE TABLE close_day_schedule (
	id INTEGER NOT NULL,
	enabled INTEGER DEFAULT 0 NOT NULL,
	weekdays VARCHAR(20) DEFAULT '0,1,2,3,4' NOT NULL,
	run_time VARCHAR(5) DEFAULT '18:00' NOT NULL,
	operator_action VARCHAR(16) DEFAULT 'offline' NOT NULL,
	ticket_action VARCHAR(16) DEFAULT 'cancel' NOT NULL,
	last_run_date VARCHAR(10),
	PRIMARY KEY (id)
);

CREATE TABLE service_groups (
	id SERIAL NOT NULL,
	name VARCHAR NOT NULL,
	display_order INTEGER DEFAULT 0 NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE system_settings (
	id INTEGER NOT NULL,
	print_ticket VARCHAR,
	show_print_badge VARCHAR,
	ticket_print_scale_percent INTEGER,
	ticket_notice_duration_printed_seconds INTEGER,
	ticket_notice_duration_unprinted_seconds INTEGER,
	ticket_notice_printed_text VARCHAR,
	ticket_notice_unprinted_text VARCHAR,
	default_operator_status VARCHAR,
	active_ticket_on_operator_logout VARCHAR,
	hide_services_without_online_operators VARCHAR,
	redirect_allow_break VARCHAR,
	redirect_allow_offline VARCHAR,
	max_ticket_redirects INTEGER,
	operator_changelog_confirm_button_text VARCHAR(200),
	call_message_template VARCHAR,
	board_ticket_template VARCHAR,
	board_ticker_text VARCHAR(500),
	board_ticker_messages VARCHAR(4000),
	cancel_reason_options VARCHAR(4000),
	defer_reason_options VARCHAR(4000),
	auto_call_enabled VARCHAR,
	auto_call_delay_seconds INTEGER,
	called_ticket_min_wait_seconds INTEGER,
	short_service_warning_minutes INTEGER,
	max_deferred_tickets_per_operator INTEGER,
	auto_call_balance_enabled VARCHAR,
	auto_call_balance_queue_threshold INTEGER,
	auto_call_balance_min_free_operators INTEGER,
	cancelled_ticket_board_display_seconds INTEGER,
	cancelled_ticket_board_message_template VARCHAR(500),
	PRIMARY KEY (id)
);

CREATE TABLE ticket_creation_requests (
	request_id VARCHAR(36) NOT NULL,
	payload VARCHAR NOT NULL,
	response VARCHAR NOT NULL,
	PRIMARY KEY (request_id)
);

CREATE TABLE windows (
	id SERIAL NOT NULL,
	name VARCHAR NOT NULL,
	status VARCHAR,
	PRIMARY KEY (id)
);

CREATE TABLE admin_sessions (
	session_id VARCHAR NOT NULL,
	admin_id INTEGER,
	created_at TIMESTAMP WITHOUT TIME ZONE,
	last_seen TIMESTAMP WITHOUT TIME ZONE,
	is_expirable INTEGER,
	PRIMARY KEY (session_id),
	FOREIGN KEY(admin_id) REFERENCES admins (id)
);

CREATE TABLE operators (
	id SERIAL NOT NULL,
	name VARCHAR NOT NULL,
	login VARCHAR NOT NULL,
	password VARCHAR NOT NULL,
	window_id INTEGER,
	auto_call_mode VARCHAR,
	next_auto_call_at TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (id),
	UNIQUE (login),
	UNIQUE (window_id),
	FOREIGN KEY(window_id) REFERENCES windows (id)
);

CREATE TABLE services (
	id SERIAL NOT NULL,
	name VARCHAR NOT NULL,
	display_order INTEGER DEFAULT 0 NOT NULL,
	service_group_id INTEGER,
	status VARCHAR,
	is_archived INTEGER DEFAULT 0 NOT NULL,
	last_window_id INTEGER,
	operator_choice_enabled INTEGER DEFAULT 0 NOT NULL,
	operator_choice_allow_break INTEGER DEFAULT 1 NOT NULL,
	operator_choice_allow_offline INTEGER DEFAULT 0 NOT NULL,
	visible_on_terminal INTEGER DEFAULT 1 NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(service_group_id) REFERENCES service_groups (id) ON DELETE SET NULL,
	FOREIGN KEY(last_window_id) REFERENCES windows (id)
);

CREATE TABLE operator_service_notifications (
	id SERIAL NOT NULL,
	operator_id INTEGER NOT NULL,
	service_id INTEGER NOT NULL,
	enabled INTEGER DEFAULT 1 NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_operator_service_notifications UNIQUE (operator_id, service_id),
	FOREIGN KEY(operator_id) REFERENCES operators (id) ON DELETE CASCADE,
	FOREIGN KEY(service_id) REFERENCES services (id) ON DELETE CASCADE
);

CREATE TABLE operator_status_periods (
	id BIGSERIAL NOT NULL,
	operator_id INTEGER NOT NULL,
	window_id INTEGER,
	status VARCHAR(16) NOT NULL,
	started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk') NOT NULL,
	ended_at TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (id),
	CONSTRAINT ck_operator_status_periods_status CHECK (status IN ('online', 'break', 'offline')),
	CONSTRAINT ck_operator_status_periods_dates CHECK (ended_at IS NULL OR ended_at >= started_at),
	FOREIGN KEY(operator_id) REFERENCES operators (id) ON DELETE CASCADE,
	FOREIGN KEY(window_id) REFERENCES windows (id) ON DELETE SET NULL
);

CREATE TABLE sessions (
	session_id VARCHAR NOT NULL,
	operator_id INTEGER,
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
	last_seen TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL,
	is_expirable INTEGER,
	PRIMARY KEY (session_id),
	FOREIGN KEY(operator_id) REFERENCES operators (id)
);

CREATE TABLE tickets (
	id SERIAL NOT NULL,
	number INTEGER NOT NULL,
	service_id INTEGER,
	status VARCHAR,
	completion_reason VARCHAR(16),
	root_ticket_id INTEGER,
	operator_id INTEGER,
	window_id INTEGER,
	target_window_id INTEGER,
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk'),
	queue_entered_at TIMESTAMP WITHOUT TIME ZONE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk'),
	returned_to_queue_count INTEGER DEFAULT 0 NOT NULL,
	defer_reason VARCHAR(255),
	deferred_at TIMESTAMP WITHOUT TIME ZONE,
	cancel_reason VARCHAR(255),
	called_at TIMESTAMP WITHOUT TIME ZONE,
	service_started_at TIMESTAMP WITHOUT TIME ZONE,
	last_recalled_at TIMESTAMP WITHOUT TIME ZONE,
	finished_at TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (id),
	CONSTRAINT ck_tickets_completion_reason CHECK (completion_reason IS NULL OR completion_reason IN ('completed', 'redirected', 'cancelled')),
	FOREIGN KEY(service_id) REFERENCES services (id),
	CONSTRAINT fk_tickets_root_ticket_id FOREIGN KEY(root_ticket_id) REFERENCES tickets (id),
	FOREIGN KEY(operator_id) REFERENCES operators (id),
	FOREIGN KEY(target_window_id) REFERENCES windows (id)
);

CREATE TABLE window_services (
	window_id INTEGER NOT NULL,
	service_id INTEGER NOT NULL,
	priority INTEGER,
	PRIMARY KEY (window_id, service_id),
	FOREIGN KEY(window_id) REFERENCES windows (id),
	FOREIGN KEY(service_id) REFERENCES services (id)
);

CREATE TABLE ticket_admin_changes (
	id BIGSERIAL NOT NULL,
	ticket_id INTEGER NOT NULL,
	admin_id INTEGER,
	admin_login VARCHAR NOT NULL,
	previous_status VARCHAR NOT NULL,
	new_status VARCHAR NOT NULL,
	reason VARCHAR(255),
	changed_at TIMESTAMP WITHOUT TIME ZONE DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Irkutsk') NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
	FOREIGN KEY(admin_id) REFERENCES admins (id) ON DELETE SET NULL
);

CREATE INDEX ix_admins_id ON admins (id);

CREATE UNIQUE INDEX ix_admins_login ON admins (login);

CREATE INDEX ix_service_groups_id ON service_groups (id);

CREATE INDEX ix_windows_id ON windows (id);

CREATE UNIQUE INDEX ix_admin_sessions_admin_id ON admin_sessions (admin_id);

CREATE INDEX ix_operators_id ON operators (id);

CREATE INDEX ix_services_id ON services (id);

CREATE INDEX ix_operator_service_notifications_id ON operator_service_notifications (id);

CREATE INDEX ix_operator_status_period ON operator_status_periods (operator_id, started_at);

CREATE UNIQUE INDEX uq_operator_current_status ON operator_status_periods (operator_id) WHERE ended_at IS NULL;

CREATE INDEX ix_tickets_id ON tickets (id);

CREATE INDEX ix_tickets_root_ticket_id ON tickets (root_ticket_id);

CREATE INDEX ix_ticket_admin_changes_ticket_changed ON ticket_admin_changes (ticket_id, changed_at);

CREATE INDEX IF NOT EXISTS ix_services_display_order ON services (display_order, id);

CREATE INDEX IF NOT EXISTS ix_services_is_archived_display_order ON services (is_archived, display_order, id);

CREATE INDEX IF NOT EXISTS ix_tickets_operator_id ON tickets (operator_id);

CREATE INDEX IF NOT EXISTS ix_tickets_operator_finished_at ON tickets (operator_id, finished_at);

CREATE INDEX IF NOT EXISTS ix_tickets_status_queue_entered_at ON tickets (status, queue_entered_at);

CREATE INDEX IF NOT EXISTS ix_tickets_operator_deferred_at ON tickets (operator_id, deferred_at);

CREATE INDEX IF NOT EXISTS ix_tickets_window_status_deferred_at ON tickets (window_id, status, deferred_at);

CREATE INDEX IF NOT EXISTS ix_tickets_status_service_started_at ON tickets (status, service_started_at);

CREATE INDEX IF NOT EXISTS ix_operators_next_auto_call_at ON operators (next_auto_call_at) WHERE next_auto_call_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_service_groups_display_order ON service_groups (display_order, id);

CREATE INDEX IF NOT EXISTS ix_services_service_group_id ON services (service_group_id);

CREATE INDEX IF NOT EXISTS ix_operator_service_notifications_operator_id ON operator_service_notifications (operator_id);

CREATE INDEX IF NOT EXISTS ix_operator_service_notifications_service_id ON operator_service_notifications (service_id);
