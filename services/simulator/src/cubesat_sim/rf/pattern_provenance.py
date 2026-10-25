"""Selected coefficient identities and RF reference planes retained with runs."""
from ..models import content_hash


def harmonic_pattern_records(scenario):
    records = {}
    for direction in ("uplink", "downlink"):
        link = getattr(scenario, direction)
        if link.spacecraft_antenna != "spherical_harmonic":
            continue
        profile = link.spherical_harmonic_profile
        records[direction] = dict(
            name=profile.name,
            revision=profile.revision,
            profile_sha256=content_hash(profile.model_dump(mode="json")),
            frequency_hz=profile.frequency_hz,
            maximum_degree=profile.maximum_degree,
            radiation_efficiency=profile.radiation_efficiency,
            orientation_deg=link.antenna_orientation_deg,
            provenance=profile.provenance.model_dump(mode="json"),
            gain_reference="Gain relative to accepted antenna-port power; radiation efficiency included once; mismatch is not included.",
            field_reference="Complex transverse transmit far field; exp(+jωt); coefficient origin is nominal, not a measured phase center.",
            frequency_scope="Single supplied frequency; no interpolation or extrapolation.",
        )
    return records
