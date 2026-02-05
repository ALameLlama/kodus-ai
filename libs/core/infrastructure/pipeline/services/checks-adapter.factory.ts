import { PlatformType } from '@libs/core/domain/enums';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';
import { Injectable } from '@nestjs/common';
import { IChecksAdapter } from '../interfaces/checks-adapter.interface';
import { NullChecksAdapter } from './null-checks.adapter';

@Injectable()
export class ChecksAdapterFactory {
    constructor(
        private readonly githubChecksService: GithubChecksService,
        private readonly nullChecksAdapter: NullChecksAdapter,
    ) {}

    getAdapter(platformType: PlatformType): IChecksAdapter {
        switch (platformType) {
            case PlatformType.GITHUB:
                return this.githubChecksService;
            default:
                return this.nullChecksAdapter;
        }
    }
}
