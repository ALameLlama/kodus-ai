import { LibraryKodyRule } from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import { ApiProperty } from '@nestjs/swagger';

export class PaginationMetadata {
    @ApiProperty({ type: Number })
    currentPage: number;
    @ApiProperty({ type: Number })
    totalPages: number;
    @ApiProperty({ type: Number })
    totalItems: number;
    @ApiProperty({ type: Number })
    itemsPerPage: number;
    @ApiProperty({ type: Boolean })
    hasNextPage: boolean;
    @ApiProperty({ type: Boolean })
    hasPreviousPage: boolean;
}

export class PaginatedLibraryKodyRulesResponse {
    @ApiProperty({
        type: Object,
        isArray: true,
        description:
            'Library rules list (schema varies by provider/configuration).',
    })
    data: LibraryKodyRule[];
    @ApiProperty({ type: PaginationMetadata })
    pagination: PaginationMetadata;
}
