"""Exercise ticket claims with independent PostgreSQL transactions."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.models import Operator, Ticket
from app.services.tickets import claim_next_ticket




def seed(sessions, count):
    with sessions.begin() as db:
        db.add_all([Ticket(number=i, service_id=1, status="waiting") for i in range(1, count + 1)])


def claim(sessions, operator_id):
    with sessions.begin() as db:
        ticket, claimed = claim_next_ticket(
            db, operator=db.get(Operator, operator_id), require_online=True
        )
        return (ticket.id if ticket else None), claimed


@pytest.mark.parametrize("count", [1, 2])
def test_competing_operators_skip_uncommitted_claim(database, count):
    seed(database, count)
    # Keep the first assignment uncommitted while the other operator calls.
    with database.begin() as first:
        ticket, claimed = claim_next_ticket(first, operator=first.get(Operator, 1))
        assert claimed
        first_id = ticket.id
        with ThreadPoolExecutor(max_workers=1) as executor:
            second_id, second_claimed = executor.submit(claim, database, 2).result(timeout=12)
        assert second_claimed is (count == 2)
        assert second_id != first_id
    with database() as db:
        rows = db.query(Ticket).filter_by(status="called").all()
        assert len(rows) == count
        assert len({row.operator_id for row in rows}) == count
        assert len({row.window_id for row in rows}) == count


def test_simultaneous_requests_for_same_window_return_same_ticket(database):
    seed(database, 2)
    start = Barrier(2)

    def call():
        start.wait(timeout=5)
        return claim(database, 1)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(call) for _ in range(2)]
        results = [future.result(timeout=12) for future in futures]
    assert results[0][0] == results[1][0]
    assert sorted(result[1] for result in results) == [False, True]
    assert claim(database, 1) == (results[0][0], False)
    with database() as db:
        assert db.query(Ticket).filter_by(status="waiting").count() == 1
        assert db.query(Ticket).filter_by(status="called").count() == 1


def test_failure_before_commit_releases_ticket_for_retry(database):
    seed(database, 1)
    with pytest.raises(RuntimeError, match="simulated failure"):
        with database.begin() as db:
            ticket, claimed = claim_next_ticket(db, operator=db.get(Operator, 1))
            assert claimed
            ticket_id = ticket.id
            raise RuntimeError("simulated failure")
    with database() as db:
        ticket = db.get(Ticket, ticket_id)
        assert (ticket.status, ticket.operator_id, ticket.window_id) == ("waiting", None, None)
    assert claim(database, 2) == (ticket_id, True)
    assert claim(database, 2) == (ticket_id, False)
