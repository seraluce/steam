import { Fragment } from 'react';
import Link from 'next/link';
import { Button } from '@heroui/react';
import SearchInput from './profile/SearchInput';

export default function PrivateGames({ steamId, countryCode, countryAbbr }) {
    return (
        <Fragment>
            <div className='flex justify-center w-full h-full'>
                <div className='relative flex justify-center items-center flex-col gap-8 w-full h-3/4 bg-base border border-light-border p-4 rounded-md lg:w-3/4 lg:h-1/2'>
                    <p className='text-4xl font-bold text-center'>Uh-oh!</p>
                    <p className='text-center'>This account has their games list set to private so we&apos;re unable to provide much information.</p>
                    <Link href={`https://steamcommunity.com/profiles/${steamId}/edit/settings`} target='_blank'>
                        <Button className='bg-pop text-white dark:text-black font-medium rounded-md'>
                            Change Account Privacy
                        </Button>
                    </Link>
                    <SearchInput countryCode={countryCode} countryAbbr={countryAbbr} />
                </div>
            </div>
        </Fragment>
    );
}