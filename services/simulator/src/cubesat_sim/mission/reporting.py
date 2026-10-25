"""Bounded interval accounting for UTC days and grid-resolved geometric passes.

The driver supplies accepted intervals and its held rates. Reporting never
propagates states or derives delivery from output samples.
"""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import math

DIRECTIONS = ("uplink", "downlink")


def _utc(value):
    return value.isoformat().replace("+00:00", "Z")


def _direction(delivery):
    return dict(
        scheduled_s=0.0,
        ideal_contact_s=0.0,
        ideal_capacity_bits=0.0,
        delivered_useful_bits=0 if delivery else None,
        delivery_available=True if delivery else None,
        receiver_locked_s=0.0 if delivery else None,
        receiver_ready_s=0.0 if delivery else None,
    )


class MissionReporter:
    def __init__(self, epoch_utc, *, delivery_enabled=False):
        self.epoch = datetime.fromisoformat(epoch_utc.replace("Z", "+00:00"))
        if self.epoch.tzinfo is None or self.epoch.utcoffset() != timedelta(0):
            raise ValueError("Reporting epoch must explicitly identify UTC")
        self.epoch = self.epoch.astimezone(timezone.utc)
        self.delivery_enabled = delivery_enabled
        self.days = {}
        self.passes = []
        self.active_pass = None
        self.time_s = 0.0

    def _period(self, start, *, date=None):
        result = dict(
            start_s=start, end_s=start,
            start_utc=_utc(self.epoch + timedelta(seconds=start)),
            end_utc=_utc(self.epoch + timedelta(seconds=start)),
            computed_duration_s=0.0,
            geometric_visible_s=0.0,
            scheduled_contact_s=0.0,
            uplink=_direction(self.delivery_enabled),
            downlink=_direction(self.delivery_enabled),
        )
        if date is not None:
            result.update(date_utc=date, partial_day=True,
                          geometric_pass_count=0, geometric_pass_entries=0)
        return result

    def _extend(self, period, end, visible, scheduled, direction, rates, delivered):
        elapsed = end - period["end_s"]
        period["end_s"] = end
        period["end_utc"] = _utc(self.epoch + timedelta(seconds=end))
        period["computed_duration_s"] += elapsed
        if visible:
            period["geometric_visible_s"] += elapsed
        if scheduled:
            period["scheduled_contact_s"] += elapsed
            period[direction]["scheduled_s"] += elapsed
        for name in DIRECTIONS:
            result = period[name]
            rate = rates[name]
            if rate is None:
                result["ideal_capacity_bits"] = None
            elif result["ideal_capacity_bits"] is not None:
                result["ideal_capacity_bits"] += rate * elapsed
            if rate is not None and rate > 0:
                result["ideal_contact_s"] += elapsed
            if delivered is not None:
                increment = delivered[name]
                if not increment["delivery_available"]:
                    result["delivery_available"] = False
                    result["delivered_useful_bits"] = None
                elif result["delivered_useful_bits"] is not None:
                    result["delivered_useful_bits"] += increment["delivered_useful_bits"]
                for field in ("receiver_locked_s", "receiver_ready_s"):
                    result[field] += increment[field]

    def advance(self, start_s, end_s, *, visible, elevation_deg, radio_active,
                direction, ideal_rates_bps, delivery_interval=None):
        if not math.isclose(start_s, self.time_s, rel_tol=0, abs_tol=1e-8) or end_s <= start_s:
            raise ValueError("Reports require contiguous positive accepted intervals")
        if self.delivery_enabled and delivery_interval is None:
            raise ValueError("Delivery-enabled reports require accepted-interval counters")
        if visible and self.active_pass is None:
            if len(self.passes) >= 10000:
                raise ValueError("Mission exceeds the 10000 geometric pass reporting limit")
            self.active_pass = self._period(start_s)
            self.active_pass.update(pass_index=len(self.passes) + 1,
                                    start_clipped=start_s == 0,
                                    end_clipped=True,
                                    max_elevation_deg=elevation_deg)
            self.passes.append(self.active_pass)
        elif not visible:
            if self.active_pass is not None:
                self.active_pass["end_clipped"] = False
            self.active_pass = None
        if self.active_pass is not None:
            self.active_pass["max_elevation_deg"] = max(
                self.active_pass["max_elevation_deg"], elevation_deg)
        cursor = start_s
        while cursor < end_s:
            when = self.epoch + timedelta(seconds=cursor)
            midnight = when.replace(hour=0, minute=0, second=0, microsecond=0)
            day_end = (midnight + timedelta(days=1) - self.epoch).total_seconds()
            end = min(end_s, day_end)
            date = midnight.date().isoformat()
            day = self.days.get(date)
            if day is None:
                day = self._period(cursor, date=date)
                self.days[date] = day
            if visible:
                # A pass intersecting two UTC days contributes once to each day.
                seen = day.setdefault("_pass_ids", set())
                if self.active_pass["pass_index"] not in seen:
                    seen.add(self.active_pass["pass_index"])
                    day["geometric_pass_count"] += 1
                    if (self.active_pass["start_s"] >= cursor
                            and not self.active_pass["start_clipped"]):
                        day["geometric_pass_entries"] += 1
            day.pop("endpoint_only", None)
            day.pop("endpoint_frame_count", None)
            delivered = delivery_interval(cursor, end) if delivery_interval else None
            daily_delivery = deepcopy(delivered)
            if delivered is not None and end == day_end:
                completions = sum(
                    increment["boundary_delivered_frames"] + increment["boundary_unresolved_frames"]
                    for increment in delivered.values()
                )
                if completions:
                    next_date = (midnight + timedelta(days=1)).date().isoformat()
                    following = self.days.get(next_date)
                    if following is None:
                        following = self._period(end, date=next_date)
                        self.days[next_date] = following
                    following["endpoint_only"] = True
                    following["endpoint_frame_count"] = completions
                    for name in DIRECTIONS:
                        boundary_bits = delivered[name]["boundary_delivered_useful_bits"]
                        daily_delivery[name]["delivered_useful_bits"] -= boundary_bits
                        if delivered[name]["boundary_unresolved_frames"]:
                            following[name]["delivered_useful_bits"] = None
                            following[name]["delivery_available"] = False
                        elif following[name]["delivered_useful_bits"] is not None:
                            following[name]["delivered_useful_bits"] += boundary_bits
            self._extend(day, end, visible, radio_active, direction, ideal_rates_bps, daily_delivery)
            day["partial_day"] = not (
                day["start_utc"] == _utc(midnight) and end == day_end)
            if self.active_pass is not None:
                self._extend(self.active_pass, end, True, radio_active,
                             direction, ideal_rates_bps, delivered)
            cursor = end
        self.time_s = end_s

    def finish(self, final_visible):
        if self.active_pass is not None:
            self.active_pass["end_clipped"] = bool(final_visible)

    def snapshot(self, *, include_passes=True):
        days = [{key: deepcopy(value) for key, value in day.items() if not key.startswith("_")}
                for day in self.days.values()]
        result = dict(
            schema_version="1.0",
            epoch_utc=_utc(self.epoch),
            computed_start_utc=_utc(self.epoch),
            computed_end_utc=_utc(self.epoch + timedelta(seconds=self.time_s)),
            interval_semantics="Accepted left-held dynamics intervals; UTC midnight splits; geometric AOS/LOS resolved on the dynamics grid, not root-found; pass counts include clipped and cross-day intersections; entries exclude initial clipped passes",
            capacity_kind="ideal_threshold_capacity_not_packet_delivery",
            delivery_kind="explicit_receiver_frame_model" if self.delivery_enabled else "not_modeled",
            frame_time_semantics="Frames credited by completion UTC timestamp; exact midnight belongs to the new date. A completed frame at the mission's final midnight may create an endpoint-only zero-duration day; receiver durations remain interval integrals.",
            completed_pass_count=sum(not item["end_clipped"] for item in self.passes),
            days=days,
        )
        if include_passes:
            result["passes"] = deepcopy(self.passes)
            for item in result["passes"]:
                item["duration_s"] = item["computed_duration_s"]
        return result
