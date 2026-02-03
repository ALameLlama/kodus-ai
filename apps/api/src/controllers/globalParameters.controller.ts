import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { CacheService } from '@libs/core/cache/cache.service';

import { Controller, Post, UseGuards } from '@nestjs/common';

const GLOBAL_IGNORE_PATHS_CACHE_KEY = 'global:ignore_paths';

@Controller('global-parameters')
export class GlobalParametersController {
    constructor(private readonly cacheService: CacheService) {}

    @Post('ignore-paths/invalidate-cache')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    async invalidateIgnorePathsCache() {
        await this.cacheService.removeFromCache(GLOBAL_IGNORE_PATHS_CACHE_KEY);
        return {
            success: true,
            message: 'Global ignore paths cache invalidated',
        };
    }
}
