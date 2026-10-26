"""Portable lifetime management for subprocesses owned by the local service."""
import asyncio
import os
import signal


def owned_process_options():
    return {"start_new_session": True} if os.name == "posix" else {}


async def terminate_owned(process, timeout_s=2):
    if process.returncode is not None:
        return

    def send(force=False):
        try:
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
                    return
                except PermissionError:
                    pass
            if force:
                process.kill()
            else:
                process.terminate()
        except ProcessLookupError:
            pass

    send()
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout_s)
    except TimeoutError:
        send(force=True)
        await process.wait()


async def create_owned_process(*command, **options):
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(
        *command, **owned_process_options(), **options,
    ))
    try:
        return await asyncio.shield(spawning)
    except asyncio.CancelledError:
        # Cancellation may arrive after the OS created the child but before assignment.
        process = await spawning
        await terminate_owned(process)
        raise
