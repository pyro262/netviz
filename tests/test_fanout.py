import asyncio
import pytest
from netviz.events import Event
from netviz.fanout import Fanout, CLOSE


def _ev():
    return Event(ts=1.0, kind="block", src_ip="203.0.113.9",
                 dst_ip="192.168.0.1", bytes=60, proto=6)


async def test_broadcast_reaches_registered_client():
    f = Fanout()
    q = f.register("client-a")
    f.broadcast(_ev())
    assert q.get_nowait()["k"] == "block"


async def test_broadcast_with_no_clients_is_a_noop():
    f = Fanout()
    f.broadcast(_ev())
    assert f.stats["sent"] == 0


async def test_slow_client_is_dropped_not_buffered():
    f = Fanout(queue_size=2)
    f.register("slow")
    for _ in range(5):
        f.broadcast(_ev())
    assert f.client_count == 0
    assert f.stats["dropped_clients"] == 1


async def test_fast_client_survives_while_slow_one_is_dropped():
    f = Fanout(queue_size=2)
    slow = f.register("slow")
    fast = f.register("fast")
    for _ in range(3):
        f.broadcast(_ev())
        while not fast.empty():
            fast.get_nowait()
    # After 3 broadcasts, slow's queue was full on broadcast 3, so it was drained
    # and CLOSE was sent. Slow is now unregistered. Fast survives and is still registered.
    assert f.client_count == 1
    assert slow.get_nowait() is CLOSE  # Queue contains only the CLOSE sentinel


async def test_unregister_is_idempotent():
    f = Fanout()
    f.register("a")
    f.unregister("a")
    f.unregister("a")
    assert f.client_count == 0


async def test_dropped_client_receives_close_sentinel():
    """A slow client that gets dropped receives CLOSE as the last retrievable item."""
    f = Fanout(queue_size=2)
    slow = f.register("slow")
    for _ in range(5):
        f.broadcast(_ev())
    assert f.client_count == 0
    # Drain regular events (backlog was discarded), then CLOSE should be last.
    while not slow.empty():
        item = slow.get_nowait()
        if item is CLOSE:
            break
    else:
        pytest.fail("CLOSE sentinel not found in queue after drop")


async def test_awaiting_consumer_receives_close():
    """A coroutine blocked in await queue.get() wakes when drop sends CLOSE sentinel."""
    f = Fanout(queue_size=2)
    slow = f.register("slow")
    received = []

    async def consumer():
        """Consumer that drains the queue, recording each item."""
        while True:
            item = await slow.get()
            received.append(item)
            if item is CLOSE:
                break

    # Create and start the consumer task, letting it run to block in await queue.get().
    task = asyncio.create_task(consumer())
    await asyncio.sleep(0)  # Yield control so consumer reaches await queue.get()

    # Consumer is now genuinely blocked in await queue.get() with empty queue.
    assert not task.done()

    # Broadcast events. Consumer is suspended, so events accumulate in the queue buffer.
    f.broadcast(_ev())  # queue buffer size 1/2
    f.broadcast(_ev())  # queue buffer size 2/2, full

    # Verify consumer is still blocked and queue is at capacity.
    assert not task.done()
    assert slow.full()

    # Broadcast a third event: queue is full, so QueueFull is raised and drop is triggered.
    # Drop drains the queue and puts CLOSE sentinel.
    f.broadcast(_ev())  # Queue full → drop → drain → CLOSE put

    # Consumer is still blocked in its await queue.get() call. When we wait for it,
    # it will resume and receive CLOSE as the first and only item.
    await asyncio.wait_for(task, timeout=1.0)

    # Verify consumer received CLOSE as the only item (proving it was blocked until drop).
    assert len(received) == 1
    assert received[0] is CLOSE
    # Verify the client is gone from the fanout.
    assert f.client_count == 0
    assert f.stats["dropped_clients"] == 1


async def test_close_client_on_unknown_key_is_safe():
    """close_client on a key that doesn't exist is idempotent."""
    f = Fanout()
    f.close_client("nonexistent")  # Should not raise
    assert f.client_count == 0


async def test_fast_client_never_receives_close():
    """A fast client that keeps up is not affected by slow client drop."""
    f = Fanout(queue_size=2)
    slow = f.register("slow")
    fast = f.register("fast")
    # Fill slow, drain fast.
    for _ in range(3):
        f.broadcast(_ev())
        while not fast.empty():
            item = fast.get_nowait()
            assert item is not CLOSE
    # Verify fast is still registered and slow is gone.
    assert f.client_count == 1
    assert "fast" in f._clients


async def test_broadcast_shares_dict_by_reference():
    """All clients receive the same wire dict object (is comparison)."""
    f = Fanout()
    q1 = f.register("client1")
    q2 = f.register("client2")
    f.broadcast(_ev())
    msg1 = q1.get_nowait()
    msg2 = q2.get_nowait()
    assert msg1 is msg2  # Identical object, not just equal
