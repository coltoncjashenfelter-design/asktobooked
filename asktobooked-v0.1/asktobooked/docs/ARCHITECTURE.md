# asktobooked Home Graph

The central object is the **Property/Home**, not the lead.

```text
Organization
  └── Homeowner
       └── Property (Home)
            ├── Assets / equipment
            ├── Service Events
            ├── Home Record access
            ├── Opportunities
            ├── Interactions
            └── Bookings
```

The homeowner and property are separate because ownership can change while the property's service history remains valuable.

## Core entities

**Organization** — contractor account, trade, service area, booking destination.

**Homeowner** — current relationship/contact identity and communication permission state.

**Property** — durable home identity, deduplicated within an organization by normalized address.

**Asset** — furnace, heat pump, water heater, panel, roof, etc. HVAC is the first supported trade.

**Service Event** — installation, repair, maintenance, estimate, membership, or other work/history event.

**Opportunity** — a reasoned future-value object produced by the engine. It always includes a human-readable reason, confidence, estimated value, status, and links back to the home.

**Interaction** — homeowner/contractor/system event used for attribution and future automation.

**Booking** — downstream economic conversion, linked back to an Opportunity when possible.

**Home Record Access** — secure homeowner-facing relationship token and claim status.

## Durable event vocabulary

The next backend iteration should persist events such as:

```text
homeowner.created
property.created
asset.registered
estimate.created
estimate.aged
job.completed
home_record.invited
home_record.claimed
maintenance.upcoming
maintenance.overdue
opportunity.created
opportunity.booked
opportunity.won
booking.created
```

This turns hard-coded workflows into an eventual rule/event system without changing the Home Graph.

## Metric hierarchy

North Star: **Homes Under Care**

Supporting metrics:

- Home Records claimed
- Continuity rate
- open opportunity value
- high-confidence opportunity value
- recovered/booked revenue
- dormant relationship count
- maintenance opportunity count
- replacement-window value
- estimate recovery value
- acquisition / conversion / retention / continuity audit score

AI/local visibility remains an acquisition module. Revenue leakage becomes the Opportunity Engine. Home Records become the homeowner-side distribution and retention layer.
