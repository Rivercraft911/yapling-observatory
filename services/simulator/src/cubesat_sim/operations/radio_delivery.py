"""Deterministic saturated-GCS delivery with explicitly assumed receiver timing.

The caller supplies a piecewise-constant C/N0 and accepted radio schedule. A
frame succeeds only if the receiver is locked and above its assumed decoder
threshold throughout that complete frame. Fading within an input interval is
unresolved. No calibrated FER, TS reassembly, traffic queue, retry or ACM exists.
"""
from bisect import bisect_right
from dataclasses import dataclass
from fractions import Fraction
import math

from .radio_delivery_models import (
    ETSI_SOURCE, ESP_REVISION, NORMAL_KBCH, SHORT_KBCH,
    DeliveryMode, DirectionDelivery, RadioDeliveryConfig,
)

MODEL_VERSION = "deterministic-dvb-gcs-delivery-0.1.0"
DIRECTIONS = ("uplink", "downlink")
_ZERO = Fraction(0)


def _seconds(value):
    return Fraction(str(value))


@dataclass(frozen=True)
class FrameLayout:
    fecframe_bits: int
    kbch_bits: int
    data_field_bits: int
    plframe_symbols: int
    duration_s: Fraction


def frame_layout(mode: DeliveryMode):
    """EN302307-1 V1.4.1 Tables5a/5b, Figure13 and clause5.5.3."""
    fec_bits = 16200 if mode.frame_size == "short" else 64800
    kbch = (SHORT_KBCH if mode.frame_size == "short" else NORMAL_KBCH)[mode.code_rate]
    slots = fec_bits // (90 * (2 if mode.modulation == "QPSK" else 3))
    symbols = 90 * (slots + 1) + (36 * ((slots - 1) // 16) if mode.pilots else 0)
    return FrameLayout(fec_bits, kbch, kbch - 80, symbols,
                       Fraction(symbols) / _seconds(mode.symbol_rate_sps))


def _quality(first, second):
    if first is False or second is False:
        return False
    return None if first is None or second is None else True


class _Direction:
    def __init__(self, profile: DirectionDelivery, direction, emit):
        self.profile, self.direction, self.emit = profile, direction, emit
        self.modes = {mode.mode_id: mode for mode in profile.modes}
        self.layouts = {mode.mode_id: frame_layout(mode) for mode in profile.modes}
        self.schedule = [(_seconds(change.start_s), change.mode_id) for change in profile.schedule]
        self.schedule_times = [change[0] for change in self.schedule]
        self.mode_id = profile.initial_mode_id
        self.last_mode_change = _ZERO
        self.reconfigure_until = None
        self.acquisition_started = None
        self.loss_started = None
        self.acquisition_required = _seconds(profile.acquisition_s)
        self.active = False
        self.previously_active = False
        self.state = "idle"
        self.remaining = _ZERO
        self.frame_quality = True
        self.delivery_available = True
        self.counters = dict(
            frames_started=0, delivered_frames=0, lost_frames=0, aborted_frames=0,
            unresolved_frames=0, offered_useful_bits=0, delivered_useful_bits=0,
            lost_useful_bits=0, unresolved_useful_bits=0,
            offered_data_field_bits=0, delivered_data_field_bits=0,
            acquisition_count=0, lock_loss_count=0, lock_reset_count=0,
            mode_change_count=0,
        )
        self.locked_time = _ZERO
        self.ready_time = _ZERO
        self.active_time = _ZERO
        self.reconfiguration_time = _ZERO
        self.unresolved_time = _ZERO
        self.last_completed_time = None
        self.last_completed_payload = 0
        self.last_completed_quality = False

    @property
    def mode(self):
        return self.modes[self.mode_id]

    @property
    def layout(self):
        return self.layouts[self.mode_id]

    @property
    def payload_bits(self):
        return self.layout.data_field_bits - self.profile.application_overhead_bits_per_frame

    def _event(self, time, cause):
        self.emit(dict(time_s=float(time), direction=self.direction, type="receiver",
                       state=self.state, mode_id=self.mode_id, cause=cause))

    def _state(self, state, time, cause):
        if self.state != state:
            self.state = state
            self._event(time, cause)

    def _begin_acquisition(self, time, cause, reacquiring=True):
        self.acquisition_started = self.loss_started = None
        self.acquisition_required = _seconds(
            self.profile.reacquisition_s if reacquiring else self.profile.acquisition_s)
        self._state("acquiring", time, cause)

    def _desired(self, time):
        index = bisect_right(self.schedule_times, time) - 1
        return self.schedule[index][1] if index >= 0 else self.profile.initial_mode_id

    def _change_mode(self, time, mode_id):
        if self.state == "locked":
            self.counters["lock_reset_count"] += 1
        self.mode_id = mode_id
        self.last_mode_change = time
        self.counters["mode_change_count"] += 1
        self.acquisition_started = self.loss_started = None
        self.reconfigure_until = time + _seconds(self.profile.mode_change_s)
        self._state("reconfiguring", time, "scheduled_mode_change")

    def _normalize(self, time, cn0, known_outage):
        desired = self._desired(time)
        if (desired != self.mode_id and not self.remaining
            and time >= self.last_mode_change + _seconds(self.profile.minimum_dwell_s)):
            self._change_mode(time, desired)
        if self.reconfigure_until is not None:
            if time < self.reconfigure_until:
                return
            self.reconfigure_until = None
            self._begin_acquisition(time, "mode_change_complete")
        threshold = self.mode.decode_threshold_esn0_db
        if not known_outage and (threshold is None or cn0 is None):
            self.acquisition_started = self.loss_started = None
            self._state("unresolved", time, "threshold_or_channel_unresolved")
            return
        esn0 = cn0 - 10 * math.log10(self.mode.symbol_rate_sps) if not known_outage else None
        if self.state in ("idle", "unresolved"):
            self._begin_acquisition(time, "channel_available", self.previously_active)
        if self.state == "locked":
            if known_outage or esn0 < threshold + self.profile.hold_margin_db:
                if self.loss_started is None:
                    self.loss_started = time
                if time >= self.loss_started + _seconds(self.profile.loss_hold_s):
                    self.counters["lock_loss_count"] += 1
                    self._begin_acquisition(time, "hold_threshold_timeout")
            else:
                self.loss_started = None
        if self.state == "acquiring":
            if not known_outage and esn0 >= threshold + self.profile.acquisition_margin_db:
                if self.acquisition_started is None:
                    self.acquisition_started = time
                if time >= self.acquisition_started + self.acquisition_required:
                    self.counters["acquisition_count"] += 1
                    self.acquisition_started = self.loss_started = None
                    self._state("locked", time, "acquisition_complete")
            else:
                self.acquisition_started = None

    def _start_frames(self, count):
        self.counters["frames_started"] += count
        self.counters["offered_useful_bits"] += count * self.payload_bits
        self.counters["offered_data_field_bits"] += count * self.layout.data_field_bits

    def _finish_frames(self, count, quality, completed_at=None):
        if completed_at is not None:
            self.last_completed_time = completed_at
            self.last_completed_payload = self.payload_bits
            self.last_completed_quality = quality
        if quality is True:
            self.counters["delivered_frames"] += count
            self.counters["delivered_useful_bits"] += count * self.payload_bits
            self.counters["delivered_data_field_bits"] += count * self.layout.data_field_bits
        elif quality is False:
            self.counters["lost_frames"] += count
            self.counters["lost_useful_bits"] += count * self.payload_bits
        else:
            self.counters["unresolved_frames"] += count
            self.counters["unresolved_useful_bits"] += count * self.payload_bits

    def _transmit(self, start, end, quality):
        duration = end - start
        time = start
        if self.remaining:
            used = min(duration, self.remaining)
            self.frame_quality = _quality(self.frame_quality, quality)
            self.remaining -= used
            duration -= used
            time += used
            if not self.remaining:
                self._finish_frames(1, self.frame_quality, time)
        if duration:
            whole = duration // self.layout.duration_s
            if whole:
                self._start_frames(whole)
                time += whole * self.layout.duration_s
                self._finish_frames(whole, quality, time)
                duration -= whole * self.layout.duration_s
            if duration:
                self._start_frames(1)
                self.remaining = self.layout.duration_s - duration
                self.frame_quality = quality

    def _idle(self, start):
        if self.active:
            if self.remaining:
                self.counters["aborted_frames"] += 1
                self._finish_frames(1, False)
                self.remaining = _ZERO
            if self.state == "locked":
                self.counters["lock_reset_count"] += 1
            self.active = False
            self.acquisition_started = self.loss_started = self.reconfigure_until = None
            self._state("idle", start, "radio_not_scheduled")

    def advance(self, start, end, active, cn0, known_outage):
        if not active:
            self._idle(start)
            return
        if not self.active:
            self.active = True
            self._begin_acquisition(start, "radio_scheduled", self.previously_active)
            self.previously_active = True
        time = start
        while time < end:
            self._normalize(time, cn0, known_outage)
            cuts = [end]
            schedule_index = bisect_right(self.schedule_times, time)
            if schedule_index < len(self.schedule):
                cuts.append(self.schedule[schedule_index][0])
            if self._desired(time) != self.mode_id:
                dwell_end = self.last_mode_change + _seconds(self.profile.minimum_dwell_s)
                if dwell_end > time:
                    cuts.append(dwell_end)
                elif self.remaining:
                    cuts.append(time + self.remaining)
            if self.reconfigure_until is not None:
                cuts.append(self.reconfigure_until)
            if self.acquisition_started is not None:
                cuts.append(self.acquisition_started + self.acquisition_required)
            if self.loss_started is not None:
                cuts.append(self.loss_started + _seconds(self.profile.loss_hold_s))
            boundary = min(cut for cut in cuts if cut > time)
            duration = boundary - time
            self.active_time += duration
            if self.state == "reconfiguring":
                self.reconfiguration_time += duration
            else:
                threshold = self.mode.decode_threshold_esn0_db
                known = known_outage or (threshold is not None and cn0 is not None)
                decode_good = not known_outage and known and cn0 - 10 * math.log10(self.mode.symbol_rate_sps) >= threshold
                if decode_good:
                    self.ready_time += duration
                if self.state == "locked":
                    self.locked_time += duration
                if not known:
                    self.delivery_available = False
                    self.unresolved_time += duration
                quality = None if not known else self.state == "locked" and decode_good
                self._transmit(time, boundary, quality)
            time = boundary
        self._normalize(end, cn0, known_outage)

    def sample(self, time):
        at_boundary = self.last_completed_time == time
        pending = int(bool(self.remaining))
        return dict(
            **self.counters, delivery_available=self.delivery_available,
            receiver_state=self.state, locked=self.state == "locked",
            mode_id=self.mode_id,
            mode_index=list(self.modes).index(self.mode_id),
            pending_frames=pending, pending_useful_bits=pending * self.payload_bits,
            partial_frame_elapsed_s=float(self.layout.duration_s - self.remaining) if pending else 0.0,
            locked_time_s=float(self.locked_time), ready_time_s=float(self.ready_time),
            active_time_s=float(self.active_time),
            reconfiguration_time_s=float(self.reconfiguration_time),
            unresolved_time_s=float(self.unresolved_time),
            boundary_delivered_frames=int(at_boundary and self.last_completed_quality is True),
            boundary_delivered_useful_bits=self.last_completed_payload if at_boundary and self.last_completed_quality is True else 0,
            boundary_unresolved_frames=int(at_boundary and self.last_completed_quality is None),
            boundary_unresolved_useful_bits=self.last_completed_payload if at_boundary and self.last_completed_quality is None else 0,
        )


class RadioDeliveryAccumulator:
    """One owner for both receiver states; input intervals are contiguous from t=0.

    Scheduled changes wait for minimum dwell and the end of any in-flight frame,
    pause transmission for mode_change_s and reacquire. Direction/off gaps abort
    partial frames and reset lock. All good frames are credited at completion;
    a run-ending partial remains pending. Rational phase makes adjacent interval
    subdivisions, including UTC midnights, lossless. Whole frames are batched.
    """
    def __init__(self, config: RadioDeliveryConfig):
        self.config = RadioDeliveryConfig.model_validate(config)
        self.events = []
        self.events_dropped = 0
        self._pending_events = []
        self.time = _ZERO
        self.directions = {
            direction: _Direction(getattr(self.config, direction), direction, self._emit)
            for direction in DIRECTIONS
        }

    def _emit(self, event):
        self._pending_events.append(event)

    def advance(self, start_s, end_s, active_direction, radio_active, cn0_db_hz, known_outage=None):
        if (type(start_s) not in (float, int) or type(end_s) not in (float, int)
            or not math.isfinite(start_s) or not math.isfinite(end_s)
            or end_s <= start_s or abs(float(self.time) - start_s) > 1e-9):
            raise ValueError("Delivery intervals must be finite, positive and contiguous from zero")
        if active_direction not in DIRECTIONS or type(radio_active) is not bool:
            raise ValueError("A direction and explicit boolean radio_active are required")
        if set(cn0_db_hz) != set(DIRECTIONS):
            raise ValueError("C/N0 is required for each direction, with None for unresolved values")
        for value in cn0_db_hz.values():
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                raise ValueError("C/N0 must be finite or None")
        if known_outage is None:
            known_outage = {direction: False for direction in DIRECTIONS}
        if set(known_outage) != set(DIRECTIONS) or any(type(value) is not bool for value in known_outage.values()):
            raise ValueError("Known-outage flags must be explicit booleans for each direction")
        if any(known_outage[direction] and cn0_db_hz[direction] is not None for direction in DIRECTIONS):
            raise ValueError("Known zero signal requires null C/N0, not a contradictory finite value")
        end = _seconds(end_s)
        if end <= self.time:
            raise ValueError("Delivery interval must advance time")
        self._pending_events = []
        for direction, receiver in self.directions.items():
            receiver.advance(self.time, end, radio_active and active_direction == direction,
                             cn0_db_hz[direction], known_outage[direction])
        ordered = sorted(self._pending_events, key=lambda event: (event["time_s"], DIRECTIONS.index(event["direction"])))
        available = max(0, 20000 - len(self.events))
        self.events.extend(ordered[:available])
        self.events_dropped += max(0, len(ordered) - available)
        self._pending_events = []
        self.time = end
        return self.sample()

    def sample(self):
        return {direction: receiver.sample(self.time) for direction, receiver in self.directions.items()}

    def summary(self):
        return self.sample()

    def metadata(self):
        return dict(
            model_version=MODEL_VERSION,
            config=self.config.model_dump(mode="json"),
            sources=[dict(source=ETSI_SOURCE,
                          locators="EN302307-1 V1.4.1 Tables5a/5b pp.22–23;5.1.5–5.1.6 pp.18–19;Figure13/Table11 p.31;5.5.3 p.33"),
                     dict(source="stanford-ssi/esp-dvbs2 local repository", revision=ESP_REVISION,
                          locators="host/dvbs2.py GCS framing;docs/transmitting.md rates/frames and VCM;docs/vcm.md paired-hardware limits")],
            limits=[
                "Simulated saturated generic-continuous-stream delivery under explicit timing and whole-frame hard-threshold assumptions; not measured packets or calibrated receiver performance.",
                "Each DATA FIELD is one frame-aligned application unit, with explicit overhead. No arrival queue, retry, TS packet reassembly, Morse ID or downstream throughput bottleneck is represented.",
                "The legacy RF threshold estimate retains its approximate net_efficiency assumption. Exact-framing saturated GCS payload uses a different boundary and need not be below that estimate. Offered useful bits bound delivered useful bits within this accounting model.",
                "Known zero-signal antenna/polarization nulls use an explicit known_outage flag, fail capture/hold/decode and remain resolved losses. They are distinct from unavailable patterns or unknown receiver thresholds; no finite C/N0 floor is substituted.",
                "Input C/N0 is held for each supplied accepted interval; unresolved within-interval fades require numerical refinement. A successful frame requires locked reception and threshold throughout its complete duration.",
                "Scheduled changes wait for dwell and the current frame boundary, then pause/reacquire. Direction/off gaps reset lock and discard a partial frame. No delayed-feedback ACM or hardware ACM claim.",
                "ready_time_s is active non-reconfiguration time above the decoder threshold; locked_time_s includes any configured loss-hold grace. acquisition_count counts successful locks; lock_loss_count counts hold-threshold timeouts; planned resets have a separate count.",
                "Frames are credited at completion including the interval right endpoint. boundary_* counters expose a completion exactly at the latest end, allowing UTC calendar rebucketing without per-frame events. Event lists are chronological; simultaneous independent directions have uplink-first tie order, preserving each receiver causal order.",
                "Unresolved thresholds/channel values do not become zero-loss claims: delivery_available becomes false and unresolved frames/bits are retained separately. End-of-run partial frames remain pending and uncredited.",
            ],
            events_dropped=self.events_dropped,
        )
