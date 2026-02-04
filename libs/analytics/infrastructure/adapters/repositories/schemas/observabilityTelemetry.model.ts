import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

@Schema({
    collection: 'observability_telemetry',
    timestamps: true,
})
export class ObservabilityTelemetryModel extends CoreDocument {
    @Prop({ type: String, required: true })
    name: string;

    @Prop({ type: String, required: true })
    correlationId: string;

    @Prop({ type: Number, required: true })
    duration: number;

    @Prop({ type: Object, required: true })
    attributes: Record<string, any>;

    @Prop({ type: Date })
    timestamp: Date;
}

export const ObservabilityTelemetryModelSchema = SchemaFactory.createForClass(
    ObservabilityTelemetryModel,
);

// Indexes for token usage queries performance
ObservabilityTelemetryModelSchema.index(
    { 'attributes.organizationId': 1, timestamp: -1 },
    { background: true },
);
ObservabilityTelemetryModelSchema.index(
    { 'attributes.organizationId': 1, 'attributes.prNumber': 1, timestamp: -1 },
    { background: true },
);
