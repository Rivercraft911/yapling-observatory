"""Validated SI lumped thermal inputs, independent of orbit, HTTP and rendering."""

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ThermalModel(BaseModel):
    model_config = ConfigDict(
        frozen=True, extra="forbid", allow_inf_nan=False, validate_default=True
    )


class ThermalNode(ThermalModel):
    node_id: str = Field(min_length=1, max_length=80)
    heat_capacity_j_k: float = Field(gt=0)
    initial_temperature_k: float = Field(gt=0)
    radiating_area_m2: float = Field(
        ge=0,
        description="Total exterior area emitting to Earth plus space; excludes internal pair-exchange surfaces",
    )
    solar_absorptivity: float = Field(ge=0, le=1)
    infrared_emissivity: float = Field(ge=0, le=1)
    space_view_factor: float = Field(
        default=1,
        ge=0,
        le=1,
        description="Weights incident ambient-space IR only; total exterior emission is not scaled by this factor",
    )


class ConductiveLink(ThermalModel):
    first: str
    second: str
    conductance_w_k: float = Field(ge=0)


class RadiativeLink(ThermalModel):
    first: str
    second: str
    exchange_coefficient_w_k4: float = Field(
        ge=0,
        description="Reciprocal effective exchange coefficient including sigma/material/view/radiosity terms, supplied by a separate justified model",
    )


class ThermalNetwork(ThermalModel):
    nodes: tuple[ThermalNode, ...] = Field(min_length=1, max_length=32)
    conductive_links: tuple[ConductiveLink, ...] = ()
    radiative_links: tuple[RadiativeLink, ...] = ()
    space_temperature_k: float = Field(default=3, ge=0)

    @model_validator(mode="after")
    def valid_topology(self):
        ids = [node.node_id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("Thermal node IDs must be unique")
        for links in (self.conductive_links, self.radiative_links):
            seen = set()
            for link in links:
                pair = tuple(sorted((link.first, link.second)))
                if (
                    link.first == link.second
                    or not set(pair) <= set(ids)
                    or pair in seen
                ):
                    raise ValueError(
                        "Thermal links require distinct existing nodes and one undirected entry per pair"
                    )
                seen.add(pair)
        return self


class NodeForcing(ThermalModel):
    node_id: str
    internal_heat_w: float = Field(
        default=0,
        description="Net nonradiative heat/transfer into node; negative PV terminal extraction is permitted",
    )
    solar_incident_w: float = Field(default=0, ge=0)
    albedo_incident_w: float = Field(default=0, ge=0)
    earth_ir_incident_w: float = Field(
        default=0,
        ge=0,
        description="Incident IR power already integrated over the visible Earth and receiving surface; not outgoing longwave flux at Earth",
    )
