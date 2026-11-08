CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 1;

CREATE TABLE IF NOT EXISTS ticket_counter_state (
    id int PRIMARY KEY DEFAULT 1,
    current_day date NOT NULL,
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO ticket_counter_state (id, current_day)
VALUES (1, CURRENT_DATE)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION ticket_number_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_old_day date;
BEGIN
    SELECT current_day INTO v_old_day
    FROM ticket_counter_state
    WHERE id = 1
    FOR UPDATE;

    IF v_old_day < CURRENT_DATE THEN
        PERFORM setval('ticket_number_seq', 1, false);
        UPDATE ticket_counter_state
        SET current_day = CURRENT_DATE
        WHERE id = 1;
    END IF;

    IF NEW.number IS NULL THEN
        NEW.number := nextval('ticket_number_seq')::text;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_number_before_insert ON tickets;

CREATE TRIGGER ticket_number_before_insert
BEFORE INSERT ON tickets
FOR EACH ROW
EXECUTE FUNCTION ticket_number_trigger();
